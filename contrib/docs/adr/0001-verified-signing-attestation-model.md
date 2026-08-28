# ADR-0001: Verified-Only Signing Attestation Model

**Status:** Proposed  
**Date:** 2026-07-27  
**Author:** Feature B1 spike

## Context

Contract source verification runs entirely off-chain: `worker-service` rebuilds the
contract in a pinned toolchain container and compares the resulting wasm hash
against the deployed contract's on-chain wasm hash (read via RPC). A Soroban
contract cannot rebuild source or verify a build on-chain — the host environment
provides no filesystem, compiler, or networking. The verification _result_
(a contract_id → wasm_hash match, with timestamp and provenance metadata) must
therefore be bridged to the ledger in some form before any on-chain policy
contract can enforce a "verified-only" constraint at signing/auth time. This ADR
selects the attestation model for that bridge.

> **"Verified" means reproducible and attributable source provenance. It does
> not mean audited, benign, or upgrade-safe.** A verified wasm hash guarantees
> that the on-chain bytecode can be reproduced by rebuilding the claimed source
> in the canonical toolchain. It does not imply that the source is free of
> vulnerabilities, backdoors, or malicious logic. Downstream policy authors and
> integrators must not conflate verification with audit or safety.

---

## Model A — Registry contract owned by the project

A dedicated on-chain Soroban contract stores `contract_id → verification_record`
entries directly. After `worker-service` confirms a hash match, a
project-controlled backend key submits a Soroban transaction that writes the
record into the registry.

### Trust assumptions

- The project's admin key (single key or multisig address) is honest and
  operationally secure. Compromise of this key allows arbitrary entries to be
  written.
- The backend process that monitors verification completions and submits registry
  writes is not subverted (no malicious entry injection before the admin key
  signs).
- The downstream policy contract correctly reads from the registry and uses the
  data as the exclusive source of verification truth.

### Who may add or revoke entries

Only the admin key (encoded in the registry's `instance` storage at deploy time)
may write, update, or delete entries. The registry contract enforces
`admin.require_auth()` on all mutation calls. The admin key could be a single
Stellar account key or a multisig address; the registry is agnostic.

### Storage and rent cost

| Item                  | Storage type | Shape                                                                                                                   | Estimated cost                                      |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Admin address         | `instance`   | `Address` (32 bytes)                                                                                                    | ~1.5 XLM minimum (contract balance)                 |
| Per verified contract | `persistent` | Key: `Hash(contract_id)` → `VerificationRecord { wasm_hash: BytesN<32>, verified_at: u64, metadata: ... }` (~100 bytes) | ~0.5 XLM per entry minimum, plus TTL extension cost |

Each `persistent` entry has a default TTL of ~4096 ledgers (~5.7 hours at 5
seconds per ledger). To keep entries alive long-term, the admin must periodically
bump TTL — either individually or in bulk. Extending 10,000 entries to 2,000,000
ledgers (~116 days) costs roughly 50–100 XLM in total fees at current protocol-20
rates. Cost grows linearly with the number of verified contracts because each is a
separate `persistent` entry with its own TTL.

If the registry also stores the full verification provenance (source archive ref,
toolchain version, build log CID), the per-entry cost increases further.

### Latency

- `worker-service` writes `status=verified` to the shared Postgres table.
- A monitoring process (polling the same table, or a callback from
  `verification-service`) detects the completed verification and constructs a
  Soroban transaction that calls `registry.write_entry(contract_id, record)`.
- The admin key signs and submits the transaction.
- At least one Stellar ledger (~5 seconds) is required for inclusion; in
  practice, 30–60 seconds elapse between the Postgres write and the on-chain
  entry being readable, accounting for transaction submission, queueing, and
  confirmation polling.

### Failure mode if the admin key is compromised

- The attacker can write any `contract_id → any_wasm_hash` pair into the
  registry. Every downstream policy that reads from this registry will treat
  the false entry as verified.
- The attacker can also overwrite or delete existing legitimate entries, causing
  verified contracts to suddenly appear unverified.
- Recovery requires: (1) rotating the compromised admin key (which itself
  requires an on-chain admin-change call — impossible if the admin is a single
  key that is lost), (2) re-verifying every legitimate contract and re-writing
  every entry, (3) updating every downstream policy contract to point to the new
  registry if the old one must be abandoned.
- There is no containment: a single key compromise undermines all entries, past
  and future.

---

## Model B — Signed attestations validated at auth time

`worker-service` (or a dedicated signing sidecar) signs an off-chain attestation
using a known Ed25519 keypair. The attestation contains the `contract_id`,
`wasm_hash`, `timestamp`, and an optional `expiry`. The _consuming_ policy
contract verifies the attestation's signature itself at auth time using Soroban's
built-in Ed25519 verification host function. No on-chain registry write occurs at
verification time — the attestation is passed as part of the auth payload and
checked on the spot.

### Trust assumptions

- The attester's Ed25519 private signing key is kept confidential and never
  used for any other purpose. If it leaks, the attacker can forge attestations
  for any wasm hash.
- The attester's signing process correctly follows the protocol: it only signs
  attestations after `worker-service` confirms a hash match, it includes an
  accurate `timestamp`, and it never signs the same `contract_id` with a false
  `wasm_hash`.
- The attester public key embedded in each policy contract is the correct key
  and is never tampered with during contract deployment or upgrade.

### Who may add or revoke entries

- "Adding an entry" is the act of signing an attestation — anyone who holds the
  attester private key can produce a valid attestation for any contract.
- "Revoking" a specific entry is not possible on its own. The closest mechanisms
  are: (a) attestation-level expiry — the policy contract rejects attestations
  whose `expiry` ledger has passed; (b) rotating the public key in every policy
  contract — which invalidates _all_ attestations signed with the old key.
- There is no per-entry granularity: you cannot revoke a single contract_id
  without either waiting for its attestation to expire or rotating the global key.

### Storage and rent cost

| Item                | Storage type | Shape                         | Estimated cost                      |
| ------------------- | ------------ | ----------------------------- | ----------------------------------- |
| Attester public key | `instance`   | `BytesN<32>` (Ed25519 pubkey) | ~1.5 XLM minimum (contract balance) |

No `persistent` storage is used per verified contract. The attestation is passed
as a parameter (typically a `Bytes` argument) and verified ephemerally. The only
ongoing cost is extending the contract instance's TTL (same as any deployed
policy contract).

Each auth check incurs the gas cost of one Ed25519 signature verification
(~5000–10000 gas in protocol 20), which is comparable to a single `persistent`
read. This cost is paid by the auth caller (the transaction submitter), not by
the contract owner.

### Latency

- `worker-service` writes `status=verified` to Postgres.
- The signing process (a sidecar or a callback in `verification-service`)
  receives the verification result, constructs the attestation, signs it with
  the Ed25519 key (~10–50 microseconds), and stores it or returns it in the API
  response.
- No on-chain transaction is needed. The attestation is available for inclusion
  in any auth payload as soon as the signing completes — effectively
  sub-second from verification completion to enforcement visibility.

### Failure mode if the attester key is compromised

- The attacker can sign attestations for **any** contract_id and wasm hash. All
  policy contracts that trust that public key will accept the forged attestation.
- There is no central point of revocation. The public key is embedded in every
  deployed policy contract instance (per-wallet, per-policy). To revoke trust in
  the compromised key, every such instance must be updated — or replaced with a
  new instance that contains the replacement public key.
- For a system with hundreds or thousands of policy instances, this is a
  protracted recovery: each instance requires a separate Soroban transaction
  (blocked on the sponsor budget), and any instance that is not updated remains
  vulnerable.
- Attestation-level `expiry` limits the blast radius only if every forged
  attestation was given a short expiry at signing time — which the attacker
  controls. They can set `expiry = u64::MAX`.
- This model makes no distinction between a compromised attester and a
  legitimate one at the policy level, because there is only one key.

---

## Model C — Trusted-publishers model

The policy contract does not track individual verified wasm hashes at all.
Instead it maintains a small mutable set of trusted attester/publisher identities
(Ed25519 public keys or Stellar addresses) in its `instance` storage. Any wasm
hash attested by a current trusted publisher — via an off-chain signed
attestation with the same shape as Model B — is accepted at auth time without a
per-hash on-chain entry. Revocation means removing a publisher's identity from
the trusted set, not walking a list of hashes.

### Trust assumptions

- The admin address that controls the publisher set (add/remove) is honest and
  operationally secure. Compromise allows an attacker to add their own key as a
  trusted publisher.
- Each publisher's private signing key is kept confidential. Compromise of one
  publisher key allows forged attestations — but the damage is limited to that
  publisher (the admin removes the compromised key, and remaining publishers
  continue to produce valid attestations).
- At least one honest publisher remains in the set at all times.
- The admin correctly vets publishers before adding them: the publisher must be
  a known entity with a track record of correct verification operations.

### Who may add or revoke entries

- The admin (a Stellar address, single or multisig) may add or remove publisher
  identities via `admin.require_auth()`-guarded calls on the policy contract.
- Each publisher, while in the trusted set, may sign attestations for any
  contract. The act of signing IS the "add entry" operation for a given
  contract's wasm hash.
- Removing a publisher from the set revokes trust in ALL attestations signed by
  that publisher — past and future — because auth-time verification checks the
  recovered signer public key against the **current** trusted set.

### Storage and rent cost

| Item          | Storage type | Shape                                                   | Estimated cost                                                                               |
| ------------- | ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Admin address | `instance`   | `Address` (32 bytes)                                    | Included in ~1.5 XLM contract minimum                                                        |
| Publisher set | `instance`   | `Vec<BytesN<32>>` (k publisher pubkeys, ~32 bytes each) | Included in ~1.5 XLM minimum for k < ~20 entries (instance ledger entry is bounded at ~4 KB) |

As with Model B, no `persistent` storage is used per verified contract.
Attestations are passed as parameters and verified ephemerally. The total
on-chain storage cost is O(k) where k is the number of publishers — a small
constant (typically 1–5). There is no per-contract storage cost regardless of
how many contracts are verified.

Auth-time cost is identical to Model B: one Ed25519 signature verification per
attestation. If publishers are Stellar addresses (not raw pubkeys) and
`require_auth()` is used instead of signature verification, the cost is even
lower since the Soroban host already authenticates the signing address.

### Latency

Identical to Model B: the attestation is signed and available sub-second after
verification completes. No on-chain transaction at verification time.

### Failure mode if a publisher key is compromised

- The attacker can sign attestations for arbitrary contract_id and wasm hash
  values using that publisher's key.
- **Containment:** only contracts attested by the compromised publisher are
  affected. Attestations from other publishers remain valid. If the set contains
  multiple publishers, the honest ones' attestations continue to provide
  coverage.
- **Recovery:** the admin removes the compromised publisher's key from the
  trusted set. This is a single on-chain transaction. Once confirmed (one
  ledger, ~5 seconds), all attestations bearing that compromised key are
  rejected at auth time, because the policy contract checks the signer against
  the **current** set.
- If the admin key itself is also compromised, the attacker could add a new
  publisher key to replace the removed one. This scenario requires the same
  response as Model A's admin compromise, but the blast radius is limited to
  publishers — the attacker still cannot write arbitrary state into the
  registry (there is none), they can only add themselves as a publisher and then
  sign attestations.
- Worst case (admin + all publisher keys compromised): the system is fully
  compromised. Recovery requires redeploying policy contracts with new admin
  and publisher keys. This is the same as Model A's worst case, but the absence
  of per-contract `persistent` storage makes redeployment simpler (no state
  migration needed).

---

## Recommendation: Model C — Trusted publishers

Model C is recommended. The justification follows from the constraint that
**verification truth is produced off-chain**.

The fundamental problem is bridging: a fact established outside the ledger
("contract C's wasm hash H matches source S in toolchain T at timestamp U")
must be made available to on-chain policy logic. There are two approaches to
this bridge:

1. **Mirror the fact on-chain** (Model A): write the verification record into
   ledger storage. This works but creates an O(n) storage burden, introduces
   latency between fact-establishment and on-chain visibility, and centralizes
   trust in a write-key that, if compromised, poisons every entry.

2. **Carry the fact as evidence and verify it at use time** (Models B and C):
   the verification result is a signed statement that accompanies the
   transaction. The on-chain component authorizes _who_ may create such
   statements, not the statements themselves.

Model B takes approach (2) but embeds a single attester key in each policy
contract instance. This makes key rotation a deployment-level operation —
unacceptable for a system that may have hundreds of policy instances, because a
compromise response would require updating every one.

Model C also takes approach (2) but separates the authorization layer (the
publisher set) from the attestation layer (the signed fact). This separation
mirrors the off-chain nature of verification:

- **Off-chain (verification):** `worker-service` rebuilds and compares hashes.
  The result is a fact that exists outside the ledger.
- **Off-chain (attestation):** a trusted publisher signs that fact. The
  signature is the bridge — it cryptographically binds the off-chain fact to the
  publisher's on-chain authorization.
- **On-chain (authorization):** the policy contract stores only the set of
  trusted publisher identities. At auth time, it verifies the attestation
  signature and checks the recovered signer against the current trusted set.

This avoids the unbounded `persistent` storage cost of Model A, avoids the
impractical key-rotation story of Model B, and provides a clean compromise
response: remove the compromised publisher key in one transaction.

### Summary comparison

| Property                         | Model A                          | Model B                      | Model C                 |
| -------------------------------- | -------------------------------- | ---------------------------- | ----------------------- |
| Per-contract on-chain storage    | O(n) `persistent` entries        | None                         | None                    |
| Latency (verify → enforce)       | 30–60 s                          | < 1 s                        | < 1 s                   |
| Key compromise recovery cost     | Replace registry + re-verify all | Update every policy instance | One remove-publisher tx |
| Supports trusted-publishers mode | Not natively                     | Not natively                 | Natively                |
| Auth-time signature verify cost  | None (just read)                 | One Ed25519 verify           | One Ed25519 verify      |

---

## Revocation

### Mechanism

The admin calls `remove_publisher(pubkey)` on the policy contract (or on a
shared publisher-registry contract that the policy references). The call is
guarded by `admin.require_auth()`.

### What happens to existing state

At auth time, the policy contract recovers the signer public key from the
attestation's signature and checks it against the **current** trusted publisher
set — not the set at the time the attestation was created. Therefore:

- **Attestations signed by a removed publisher are immediately rejected.**
  All in-flight attestations (including those created milliseconds before
  the revocation) become invalid as soon as the `remove_publisher` transaction
  is confirmed, regardless of any `expiry` field they carry.
- **There is no grace period by default.** Accounts/contracts that were relying
  on a now-revoked publisher's attestations lose "verified" status at the next
  auth check. A transaction that was already submitted and is still pending
  (not yet included in a ledger) at the time of revocation will fail if it
  relies on that publisher's attestation.
- **If a grace period is desired**, the attestation's `expiry` field can be used
  as an override: the policy contract may optionally accept an attestation from a
  removed publisher if `ledger_seq < attestation.expiry`. This is a
  policy-specific opt-in and adds complexity (the policy must also bound
  `expiry` to prevent a compromised publisher from signing attestations with
  infinite expiry). The recommended default is no grace period — immediate
  revocation.

### Attestation-level revocation (contract-specific)

Model C does not support revoking a single contract's verification without
removing its publisher. This is by design: trusted-publishers mode accepts
_everything_ a trusted publisher attests. If per-contract granularity is needed
despite the trusted-publishers model, the attestation can include a
`revocation_nonce` that the policy contract checks against an on-chain
"revoked nonces" set — but this adds `persistent` storage and defeats the
purpose of Model C. For the common case, publisher-level revocation is
sufficient: if a publisher attests a contract that later turns out to be
malicious, the response is to remove that publisher and investigate how the
false attestation occurred.

---

## Trusted-publishers-only enforcement mode

Model C IS the trusted-publishers-only enforcement mode. The policy contract
never stores individual wasm hashes. At auth time:

1. The caller provides an attestation (signed payload containing `contract_id`,
   `wasm_hash`, `timestamp`, and an optional `expiry`).
2. The policy contract recovers the signer public key from the attestation's
   Ed25519 signature via a Soroban host function.
3. The policy contract checks whether the recovered public key is in the
   **current** trusted publisher set (`instance` storage).
4. If the signer is trusted, the policy contract reads the contract's actual
   wasm hash from the ledger (via `env.storage().instance()` or an RPC-read
   pattern if the hash is embedded in the contract executable) and compares it
   against the `wasm_hash` in the attestation.
5. If they match, the contract is treated as verified and the policy authorizes
   the action. If they do not match, the policy rejects the action.

This satisfies the "accept anything from a trusted attester" requirement
without per-hash on-chain entries. The attestation is the sole carrier of the
verification fact; the on-chain component only answers "is this signer
authorized to attest?"

**If Model A or Model B had been recommended instead**, supporting
trusted-publishers-only enforcement would require an additional mechanism:

- **Model A extension:** The registry contract would need a separate "trusted
  attesters" set, and a "verified-by-trusted-attester" bool or tag on each
  entry. The policy contract would read the entry and, if the tag indicates
  trusted-attester mode, skip the hash comparison and accept the entry
  regardless of its wasm hash. This adds storage and complexity to the
  registry.
- **Model B extension:** The single attester key IS the trusted publisher, so
  the model already behaves like trusted-publishers with exactly one publisher.
  Supporting multiple publishers would require adding a set — making it Model C.

Model C is recommended in part because it makes this enforcement mode the
natural behavior, not an afterthought.
