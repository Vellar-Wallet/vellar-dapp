# M5: threshold attestor design (for sign-off, nothing built)

Status: **proposal, awaiting owner sign-off.** M5 stays open and mainnet-blocking until the
attestor is wired into the worker boot path, tested end to end and on `main`
(`docs/security-audit.md`). Everything under "Candidate" exists only on the `dev` branch.

## Decision requested

Mainnet attestor = a Soroban threshold account (`contracts/threshold-attestor`) with
**N=3 signers**:

| Operation                                              | Signatures needed |
| ------------------------------------------------------ | ----------------- |
| Attest (`upsert`, `upsert_with_publisher`)             | **2 of 3**        |
| Rotate, add or remove signers (`set_signers`)          | **2 of 3**        |
| Hand the registry to another attestor (`set_attestor`) | **2 of 3**        |
| **Revoke ONE attestation record**                      | **1 of 3**        |

A single signature may authorise **exactly one record revoked**: the authorisation must
contain one call, `revoke`, on the bound registry, with one argument. A multi-call
authorisation, any other function, or any other contract needs 2-of-3.

## What a 1-of-3 revoke really is: a user-facing freeze

It is tempting to call a rogue single revoke "griefing". It is more than that. A
`verified_only` wallet's policy refuses transfers to a recipient whose attestation is
missing, expired or **revoked** (M4). So one signer, by mistake or after compromise, can
**freeze payments for every user whose policy relies on that record** until it is
re-attested at 2-of-3. The only user-side recovery is detaching the policy with their passkey
(the V3 detach UI). The fast revoke is kept on purpose, because a compromised or upgraded
contract must be removable quickly; the controls below bound what it can do.

Controls (conditions of this design):

1. **One record per single-signature authorisation**, enforced in `__check_auth` (see
   "Contract changes").
2. **Every revoke is alertable.** The worker logs a structured `attestor.revoke` line and
   the registry's revoke event is watched; the alert fires on every single-signature revoke,
   not on a threshold. The contract also records which path authorised it (see below).
3. **Re-attesting a wrongly revoked record is a documented 2-of-3 step** (runbook below).
4. Optional, needs your number: an on-chain cap on single-signature revokes per window
   (for example 5 per 24 hours = 17,280 ledgers), after which revokes need 2-of-3. Without
   it, one compromised key can still freeze records one transaction at a time, each
   individually alerting. **I recommend the cap; the value is yours to set.**

### Runbook: a record was revoked by mistake

1. Confirm from the alert which record, which signer index, which ledger.
2. Decide: wrong (re-attest) or right (leave revoked).
3. Re-attest: two signers run `upsert` for the record through the coordinator (2-of-3). The
   coordinator refuses to ask for signatures unless the signer's own independent rebuild of
   the wasm matches.
4. Verify `is_verified(record)` is true on-chain, then tell affected users nothing further is
   needed (their policy resumes).
5. If the revoking signer is suspected compromised: rotate it out with `set_signers` (2-of-3).

## Candidate on `dev`: assessment

The contract is small and sound in its core: M-of-N Ed25519 `__check_auth`, strictly ascending
signer indices, a separate revoke threshold, `set_signers` needing the current quorum. Its 12
tests call `__check_auth` directly; none runs a signed entry through the real host.

Problems found (verified by reading the code; the hash mismatch was also computed):

1. **Custody is defeated.** `ThresholdKeyManager` loads all N secret keys into one worker
   process and signs with the first M. One compromised host holds the whole quorum, which is
   exactly the M5 threat.
2. **The submitter signs the wrong hash.** It computes `sha256(passphrase || entryXdr)`; the
   Soroban host passes `sha256(HashIdPreimage{networkId, nonce, expiration, invocation})`.
   For the same entry they differ (`23953391...` vs `19727258...`), so every real submission
   would fail on-chain. Its tests use a fake server and cannot see it.
3. **Nonce is hard-coded to 0** on every entry, so a second attestation inside the
   expiration window is rejected as a reused nonce.
4. **`measureRevocationLatencyMs` performs a real revoke** in production code.
5. **`set_attestor` is a one-way door.** It needs only the current attestor's auth and the
   registry has no admin: pointing it at a misconfigured threshold account bricks the registry.
6. **The fast revoke accepts a `revoke` on any contract** and any number of calls.
7. **Instance TTL** is renewed only on use; an idle attestor can expire.
8. The submitter is imported by nothing but its own test (dead code), and `dev`'s migration
   doc calling M5 "fully resolved" is wrong.

## Design

### Contract changes (small, to be audited)

- `bind_registry(registry)`: callable once, authorised at 2-of-3. The single-signature path
  requires the call's contract to equal the bound registry. This removes problem 6.
- Single-signature path: exactly one context, `revoke`, one argument; otherwise require
  the attest threshold.
- Emit an event on each authorisation that records the path (`single_revoke` with the signer
  index, or `threshold`). Whether a custom account may emit events from `__check_auth` is to be
  confirmed on testnet; the fallback is the registry's own revoke event plus an off-chain watcher
  that reads the signature count from the transaction.
- Optional: the single-signature revoke cap above.

### Signers: independent hosts that re-verify before signing

| Signer | Where                                                          | Role                                                      |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| A      | a new Railway service in project `vellar`                      | automated verifier                                        |
| B      | a **different provider and a different account** (not Railway) | automated verifier                                        |
| C      | offline                                                        | break-glass: second signature for rotation, manual revoke |

Attest and rotate need two of A, B, C, so the **normal automated path is A+B**. C is needed only
for rotation, a manual revoke when A and B are unavailable, and recovery.

A signer **never signs a hash it is handed.** The coordinator (the worker) sends the intent: the
registry method and arguments, a nonce and an expiration ledger. The signer:

1. checks the method is allowed and the registry is the bound one;
2. rebuilds the wasm itself from the source at the commit and compares it with the claimed hash
   (for `upsert`) or checks the revocation reason (for `revoke`);
3. checks the nonce is fresh and the expiration is within bounds;
4. computes the authorisation payload **itself** with the SDK's `buildAuthorizationEntryPreimage`
   (not a hand-rolled hash) and returns one signature.

The coordinator uses a random nonce per entry and an expiration of latest + 100 ledgers, and
authenticates to signers with mutual TLS or signed requests. `ThresholdKeyManager` is replaced
by a `SignatureProvider` interface with remote implementations; no process ever holds more than
its own key.

### The two automated verifiers are independent in hosting, not in logic

Different providers and accounts protect against a host or account compromise. They do **not**
protect against a bug in the verification itself: if A and B run the same code, one defect
(for example a wasm-comparison mistake, or a crafted repository that fools the build) makes both
agree on a wrong hash and **forges an attestation with 2-of-3**. What would make them logically
independent, none of which is proposed to be built now:

- two separately written verifier implementations (different authors, ideally different language
  or toolchain), compared on a corpus of known-good and known-bad contracts;
- different build environments (different Rust toolchain versions and container bases), so a
  toolchain-specific trick cannot fool both;
- one verifier that only checks against an on-chain deployed hash (a lookup), the other that
  rebuilds;
- a differential test in CI that runs both on every fixture and fails on any disagreement;
- a human-in-the-loop signature (signer C) required for anything unusual, such as a first-time
  publisher or an unexpectedly large change.

### Who holds the offline key (signer C) and where it is stored

**Not decided; the repo cannot answer it.** The catalogue records that every single point of
failure today is one person (sponsor key, DB token, hosting account, npm, DNS). If the owner also
holds C, then C and the Railway account are the same trust domain, and compromising that one
person yields A, C and the platform account together.

Proposal, for you to confirm or replace:

- **Holder:** the project owner for now, with a named second trusted person to hold either C or
  the account that hosts B. _Holder name: TO BE FILLED IN BY THE OWNER._
- **Storage:** an ed25519 key generated on an air-gapped machine, stored on a hardware token or
  an encrypted file (age) in a physically separate location from the laptop used for deploys,
  with a written recovery procedure. The key must be able to sign a raw 32-byte payload; many
  hardware wallets only sign transactions, so confirm the device before choosing it.

### Mainnet registry deployment steps

No mainnet registry exists, so mainnet is greenfield: **no `set_attestor` handoff is needed.**

1. Prerequisites: the attestor contract and submitter promoted to `main` through reviewed PRs;
   the fixes above; a real-host test; the contract added to the external review scope.
2. Generate three ed25519 keys on three separate machines. Record only the public keys.
3. **Testnet rehearsal:** deploy the attestor (`2`, `[A,B,C]`, revoke `1`); deploy a scratch
   registry with it as the constructor attestor; `bind_registry`; then check upsert with 2
   signatures, upsert with 1 refused, a one-record revoke with 1 signature, a multi-call revoke
   with 1 signature refused, a rotation, and a TTL bump.
4. **Mainnet:** install the wasm; deploy the attestor with the same constructor; read back
   `signers()`, `threshold()`, `revoke_threshold()` by simulation; deploy a **new** registry with the
   attestor as its constructor attestor; `bind_registry`; verify `attestor()`; attest and revoke a test
   contract end to end.
5. Record the IDs; deploy the signer services; create the worker service (none exists in the
   Railway project today) with the threshold settings; the boot guard accepts threshold mode.
6. Only then enable `verified_only` on mainnet (it is gated out of the mainnet policy builder
   until a registry exists).
7. Rollback before step 6 is trivial: nothing depends on the new registry.

### Operations

- A keep-alive job extends the attestor instance TTL on a schedule well inside its renewal window.
- The relayer/fee-payer for attestor transactions is a separate low-balance G account.
- Key rotation: `set_signers` at 2-of-3, tested in the rehearsal.

## Order of work (promotion first)

This lands on `main` only after the attestor contract and submitter arrive through the reviewed
promotion PRs, and the fixes are written against `main` after that, not on a parallel branch.
The `dev` sources are `contracts/threshold-attestor/` and
`services/worker-service/src/threshold-submitter.ts` (both added in `bfeec6c`, plus the contract's
boundary tests in `1bf77d6`).

## Open items for the owner

1. Approve N=3, 2-of-3, revoke 1-of-3 with the one-record rule.
2. Set the single-signature revoke cap, or decline it.
3. Name the holder and storage of signer C, and a second trusted person.
4. Choose signer B's provider.
