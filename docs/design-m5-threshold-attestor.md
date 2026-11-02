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

Each signer may do this at most **3 times per rolling 24 hours** (17,280 ledgers), enforced in
the contract; beyond that a revoke needs 2-of-3. A single signature may authorise **exactly one record revoked**: the authorisation must
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
4. **A per-signer cap, decided: 3 single-signature revokes per rolling 24 hours (17,280
   ledgers), enforced in the contract, not in the off-chain service.** The fourth within the window
   from the same signer is refused on the 1-of-3 path and needs 2-of-3. Each signer has its own
   allowance: signer A's three do not consume signer B's. The ledger count is an approximation
   of 24 hours (ledger close time varies); the contract counts ledgers, not wall-clock time.

   Acceptance tests (all in the contract's test suite and in the real-host rehearsal):
   - the 4th single-signer revoke inside the window is refused, and a 2-of-3 revoke of the same
     record still succeeds;
   - after 17,280 ledgers the oldest of the three has aged out and a single-signer revoke is
     allowed again (boundary tested at 17,279 and 17,280);
   - signer A exhausting its allowance leaves signers B and C unaffected;
   - a 2-of-3 revoke does not consume any signer's allowance;
   - the refusal does not change any counter, and a refused attempt cannot be replayed later.

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
- **Where the cap lives.** A custom account's `__check_auth` is an authorisation hook; this design
  assumes it cannot persist state (to be confirmed on testnet), so the counter is not incremented
  there. Instead the attestor exposes `revoke_record(record, by: Option<u32>)`:
  - `__check_auth` accepts a **single signature** only when the one call is
    `revoke_record(record, Some(i))` on this attestor, `i` equals the index of the sole
    signature, and signer `i` is under its cap (it can read the counters). Otherwise it requires
    the 2-of-3 attest threshold, which also covers `revoke_record(record, None)`.
  - `revoke_record` records the ledger for signer `i` in a ring of its last 3 revoke ledgers
    (refusing the single-signer path if the oldest is within 17,280 ledgers), then calls the
    registry's `revoke(record)`. The registry's attestor is this contract, and a contract calling
    another is authorised as the invoker, so no second authorisation is needed.
    The fast path therefore no longer authorises `revoke` on the registry directly.

### Signers: independent hosts that re-verify before signing

| Signer | Where                                                                  | Role                                                      |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| A      | a new Railway service in project `vellar`                              | automated verifier                                        |
| B      | **Hetzner Cloud, in a separate account** (see "Signer B"), not Railway | automated verifier                                        |
| C      | offline                                                                | break-glass: second signature for rotation, manual revoke |

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

### Signer C: the offline key (decided)

- **Holder:** Chigozirim.
- **Form:** a hardware wallet, kept offline, with a sealed seed backup held separately from the
  device. Where the device and the backup are kept is **not recorded in this repository**, on purpose.
- **Acceptance check before relying on it:** the device must be able to sign a raw 32-byte
  Ed25519 payload for the Soroban authorisation. Many hardware wallets sign only transactions, or
  sign arbitrary hashes only behind a "blind signing" setting. Confirm the exact device and app on
  testnet in the rehearsal; if it cannot, signer C needs a different form before any mainnet use.
- Signer C is independent of the owner's laptop and of both hosting accounts by construction;
  it should also be a different **person** from whoever administers signer A's and B's accounts.

### Signer B: provider and what "independent" requires

**Proposed provider: Hetzner Cloud**, one small VPS running Docker. Reasons: it operates its own
data centres rather than reselling another cloud, it runs a Docker daemon (signers must rebuild wasm
in an isolated container, which PaaS platforms usually do not allow), and it is a different company
and jurisdiction from the Railway project. Weaknesses: you patch the OS yourself, and one region is
one failure domain.

**Signer A's host is an open question for the same reason.** The signer must rebuild wasm in a
sandbox that has no access to the signing key, and Railway services do not normally expose a Docker
daemon. If signer A cannot do an isolated rebuild on Railway, it needs a Docker-capable host too, and
that host must still differ from B's provider. Check Railway's actual capabilities before deciding;
I have not verified them.

Each signer is two parts: a **builder** (an isolated container with no network and no secrets, which
returns only the resulting hash) and a **signer** (holds one key, never executes submitted code).

"Independent" for signer B means, all of:

| Requirement                            | Meaning                                                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate provider and account          | a different company, and an account no one else's login can reach                                                                                              |
| Separate identity                      | its own email address and a hardware 2FA device not shared with A's or C's accounts                                                                            |
| Separate billing                       | its own payment instrument, so a billing dispute or suspension on one cannot take both                                                                         |
| No shared credentials                  | no shared password-manager vault, SSO, API token, SSH key, deploy key or CI secret with A, C or the Railway project                                            |
| Own source access                      | a read-only deploy key created only for B, revocable on its own                                                                                                |
| Own secrets store                      | B's key lives on B's host only; nothing about it is in the repo or in A's environment                                                                          |
| Own network identity                   | B's endpoint is authenticated by a pinned certificate or key on the coordinator, so a DNS or domain compromise cannot redirect signing requests to an impostor |
| Different administrator where possible | the person who can log in to B's account is not the only person who can log in to A's                                                                          |
| Separate failure and patching          | its own patch schedule; one platform outage or one account lock cannot stop both                                                                               |

This covers hosting independence only. Logical independence of the verifier is described above.

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

## Decisions recorded

1. N=3, attest, rotate and handoff 2-of-3, revoke 1-of-3 limited to one record per authorisation.
2. Single-signer revoke cap: **3 per rolling 24 hours per signer, in the contract.**
3. Signer C: held by **Chigozirim**, hardware wallet, offline, sealed seed backup kept separately
   (location not recorded here).
4. Signer B: Hetzner Cloud proposed, in a separate account with the independence requirements above.

## Gate: verify on testnet before anything builds on `revoke_record`

The 3-per-24-hours cap rests on one assumption: **a custom account's `__check_auth` cannot persist
state on the real Soroban host**, which is why the counter lives in `revoke_record` rather than in
`__check_auth`. The contract's own tests call `__check_auth` directly and cannot answer this; only a
real signed authorisation through the host can. **Nothing is to be built on `revoke_record` until this is
verified and the result is recorded here.**

**Status: NOT YET VERIFIED.** The probe could not be built in the working environment because compiling
any Soroban contract downloads dependencies from crates.io and the local cargo cache is empty. It is
waiting on that go-ahead; no result is claimed.

Experiment (throwaway probe, testnet only, outside this repository):

- A custom-account contract whose `__check_auth` takes a mode number as its "signature" and tries one
  thing per mode: `0` no write (control), `1` write instance storage, `2` write persistent storage,
  `3` extend the instance TTL, `4` publish an event, `5` read storage.
- A `ping` function that requires the contract's own authorisation, so the host runs `__check_auth`.
- A script that, for each mode, simulates `ping` with a hand-built authorisation entry (enforcing
  mode), then sends it, then reads the counters back with view functions.

Record, per mode: the simulation result and error text, whether the transaction succeeded, and whether
the state changed afterwards.

| Mode | What `__check_auth` tries | Simulation | Sent    | State changed | Result  |
| ---- | ------------------------- | ---------- | ------- | ------------- | ------- |
| 0    | nothing (control)         | not run    | not run | not run       | pending |
| 1    | write instance storage    | not run    | not run | not run       | pending |
| 2    | write persistent storage  | not run    | not run | not run       | pending |
| 3    | extend instance TTL       | not run    | not run | not run       | pending |
| 4    | publish an event          | not run    | not run | not run       | pending |
| 5    | read storage              | not run    | not run | not run       | pending |

What each outcome changes:

- **Writes refused (expected):** the `revoke_record` design stands as written. The existing threshold
  contract's `renew_instance` call inside `__check_auth` is then itself a bug to fix (TTL extension
  there would fail on the real host).
- **Writes allowed:** the cap can live inside `__check_auth` and `revoke_record` is unnecessary;
  simplify the design.
- **TTL extension or events allowed but storage writes refused:** keep `revoke_record` for the counter
  and use the allowed operation for the keep-alive and the alert event.

## Still open

1. Confirm the hardware wallet can sign a raw 32-byte Ed25519 payload (testnet rehearsal).
2. Signer A's host: can Railway do an isolated wasm rebuild, or does A need a Docker-capable host?
3. A second person to administer the accounts for signers A and B.
4. The testnet gate above (whether `__check_auth` may write state or emit events). Nothing builds on
   `revoke_record` until it is recorded.
