# External security review — scope package (#415)

> **Status: NOT ENGAGED.** No external reviewer has been selected, contracted, or
> briefed. This document is the scope package to hand a reviewer once one is. It
> does not record a review, and nothing in it changes the go/no-go in
> [`security-audit.md`](security-audit.md), which remains **NO-GO for mainnet**.

Prepared against `dev` at `e26c0a8` (2026-09-25). Before sending, re-pin to the
exact commit the reviewer will receive (a tag is preferable) and re-verify every
path and version below.

---

## 1. Why an external review, and why two passes

`security-audit.md` holds two internal reviews: the pre-mainnet audit and a
re-audit of its own patches (RA-1…RA-11). Two facts from those reviews set the
shape of this one:

1. **Every verdict is conditional on unread code.** The passkey ceremony, session
   store, address derivation, and the V1→V2 credential upgrade behind RA-1 live in
   `vellar-sdk` / `passkey-kit`, outside this repo. `passkey-kit`'s own README
   states that its smart-wallet contract, SDKs, and relayer proxy "have not
   received an independent third-party security audit".
2. **Remediation created new Highs.** RA-1, RA-2 and RA-11-A/B were introduced or
   missed by the first round's fixes. A single external pass is therefore not
   sufficient; the engagement must include a re-review of the fixes it produces
   (§7).

---

## 2. Reviewer selection

### Required capability

The reviewer must cover **both** halves of the boundary, not one:

- **Soroban contracts** — custom account contracts (`__check_auth`), policy signers,
  auth-context parsing, storage/TTL semantics, cross-contract reads inside auth.
- **Wallet / passkey architecture** — WebAuthn (secp256r1) ceremonies, credential
  lifecycle, origin binding, session and device-key handling in a browser
  extension, and the TypeScript SDK that glues them to the chain.

A general web-app security consultancy without Soroban account-contract
experience does not meet the bar, nor does a contract-only shop that will not
read the TypeScript SDK.

### Candidate pool

The Stellar Development Foundation's
[Soroban Security Audit Bank](https://stellar.org/grants-and-funding/soroban-audit-bank)
lists these pre-approved firms (as of 2026-09-25): Certora, Code4rena, Halborn,
Oak Security, OtterSec, Runtime Verification, Spearbit + Cantina, Veridise,
Zellic.

The Audit Bank also subsidises cost (5% co-payment, refundable when Critical,
High and Medium findings are remediated within 20 business days; 20% co-payment
for a second audit). Eligibility requires Stellar Community Fund funding, so
confirm Vellar's status before relying on it.

### Selection questions to put to each candidate

1. Prior Soroban **custom account / policy-signer** engagements (reports, not
   marketing pages).
2. Prior WebAuthn / passkey wallet reviews.
3. Will they review `vellar-sdk` and the `passkey-kit` integration surface in the
   same engagement, or only contracts?
4. Is a **fix re-review** included in the quote, and on what turnaround?
5. Deliverable format: can findings map onto the fields in §6?

Record the choice and the rationale in the tracking issue and in
`security-audit.md` (§8) when made. **Owner: maintainer** — selection and
contracting are not something a contributor can do on the project's behalf.

---

## 3. Scope A — in-tree Soroban contracts

All members of `contracts/Cargo.toml`. The issue text says "four"; that count
predates `threshold-attestor`, so the scope is **five**.

| Contract                                | Role                                                                   | Entry points                                                                                               | Review focus                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-templates/spending-limit`       | Policy signer: per-wallet native spend cap over a window               | `__constructor`, `config`, `install`, `uninstall`, `policy__`                                              | `source.require_auth()` ordering; auth-context parsing; admin-surface rejection (add/update/remove/upgrade); tumbling-window 2× (M3, documented); i128 arithmetic; persistent TTL             |
| `policy-templates/token-spending-limit` | Policy signer: token-denominated cap (agent keys, Phase 8)             | as above                                                                                                   | Token address binding; SAC vs arbitrary token `transfer` shape; per-token accounting; bounded work in `policy__`                                                                              |
| `policy-templates/verified-recipient`   | Policy signer: only allow recipients the registry attests              | `__constructor`, `config`, `install`, `uninstall`, `policy__`                                              | Cross-contract `is_verified` read inside auth; registry-absent behaviour (M4, V3 detach); TOCTOU on upgraded recipients                                                                       |
| `attestation-registry`                  | Oracle: time-bounded "contract X has verified source with wasm hash H" | `__constructor`, `upsert`, `revoke`, `set_attestor`, `is_verified`, `attestation`, `attestor`              | Attestor auth on every write; expiry fail-closed; attestor rotation; storage bloat/griefing via `upsert`; documented upgrade-staleness limit                                                  |
| `threshold-attestor`                    | M-of-N smart account acting as the registry's attestor (M5)            | `__constructor`, `threshold`, `revoke_threshold`, `signers`, `signer_count`, `set_signers`, `__check_auth` | Distinct-signer / strictly-increasing index check; separate `revoke_threshold` cannot be abused for writes; `set_signers` self-auth and threshold invariants (0, > N); replay across contexts |

### Out-of-tree contract (in scope)

The **passkey-kit smart-wallet contract** is the account every Vellar wallet
runs. It executes `__check_auth`, dispatches to the policy signers above, and
owns the admin surface they refuse. The web app pins its wasm hash in
`apps/web/lib/config.ts` (`DEFAULT_WALLET_WASM_HASH = fdefad64…03f0`). The
reviewer must confirm which `passkey-kit` source that hash builds from and review
it. It is upstream-unaudited (§1).

### Per-contract checklist

Each contract gets an explicit verdict on every row (N/A allowed, with reason):

| Area                 | Items                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Auth                 | `require_auth` placement and subject; signer validation; auth-context parsing; unexpected invocation paths  |
| Initialization       | Constructor-only init; no re-init; config immutability                                                      |
| Privileged functions | Admin/attestor/signer rotation; who can call; self-auth correctness                                         |
| Storage              | Instance vs persistent vs temporary choice; key isolation per wallet; TTL renewal; archival/restore effects |
| Upgradeability       | Upgrade entry points (or deliberate absence); migration; version identification                             |
| Replay / nonces      | Signature-payload binding; cross-contract and cross-network replay                                          |
| Arithmetic           | i128/u64 overflow, negative amounts, window boundary math                                                   |
| Tokens / addresses   | Asset address validation; SAC vs custom token; recipient validation                                         |
| Cross-contract calls | Calls from inside `__check_auth`; failure modes; call-order assumptions                                     |
| Events and errors    | Event correctness; error codes; panics that brick a wallet                                                  |
| DoS / griefing       | Resource exhaustion in auth; unbounded loops; storage bloat; forced-expiry griefing                         |
| Invariants           | State-machine invariants per contract; property/invariant tests present                                     |
| Tests                | Coverage of the above in `test.rs` and `test_snapshots/`; adversarial cases present                         |

---

## 4. Scope B — `vellar-sdk` and `passkey-kit` dependency surface

Reviewing the version pins alone is not enough. The review covers the security
boundary between this repo and these packages: what the repo assumes, and
whether the package actually guarantees it.

| Package       | Source                                                                  | Declared  | Resolved (lockfile) | Note                                                              |
| ------------- | ----------------------------------------------------------------------- | --------- | ------------------- | ----------------------------------------------------------------- |
| `vellar-sdk`  | [Vellar-Wallet/vellar-sdk](https://github.com/Vellar-Wallet/vellar-sdk) | `^0.6.2`  | `0.6.2`             | Caret range; exact pin tracked in #463                            |
| `passkey-kit` | [stellar/passkey-kit](https://github.com/stellar/passkey-kit)           | `^0.14.0` | `0.14.0`            | npm latest is `0.19.1`; review must state which version it covers |

### Where the repo crosses into them

| Consumer                                                            | Imports                                                                                | Assumption the repo makes                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/web/lib/connector-factory.ts`                                 | `createPasskeyKitConnector`, `resumeKitConnection`, `createPaymentClient`              | Passkey ceremony, device-signer attach, policy wiring         |
| `apps/web/lib/wallet-context.tsx`                                   | `createSessionStore`, `createWebStorageAdapter`, `createMemoryStorageAdapter`          | Session store integrity and lifetime                          |
| `apps/web/lib/http-backend.ts`                                      | `defaultSignedToXdr`, `WalletBackend`, `PaymentSubmitBackend`                          | Seam contract (below) matches server routes                   |
| `apps/web/lib/policy.ts`, `tokens.ts`, `balances.ts`, `dashboard/*` | payment / token types, `formatTokenAmount`                                             | Amount formatting and token identity                          |
| `apps/extension/lib/tx-signer.ts`                                   | `boundedExpirationLedger`, `configuredMainnetRpcUrl`, `resolveTrustedRpcUrl`, `Signer` | Device-signer expiry and trusted RPC anchor (L4)              |
| `services/wallet-service/src/derivation.ts`                         | `deriveContractAddress` (passkey-kit)                                                  | `/wallet/create` derivation gate (V1) is the kit's derivation |
| `services/wallet-service/src/relayer-passkey.ts`                    | `PasskeyServer` (passkey-kit/server)                                                   | Relayer submission path                                       |
| `examples/headless-agent/src/agent.ts`                              | `createX402Client`                                                                     | Agent key budget enforcement                                  |

### Flows the reviewer must trace end to end

1. **Passkey ceremony** — registration and assertion; RP ID / origin binding;
   challenge generation; secp256r1 key extraction.
2. **Credential handling** — V1 vs V2 credential encoding; the **V1→V2 upgrade**
   that drove RA-1; the route-scope gate in wallet-service that matches both.
3. **Session store** — creation, persistence adapter, expiry, revocation, and its
   relation to the server bearer capability (RA-3/M1, RA-11-A).
4. **Address derivation** — `salt = f(keyId)`, deployer, network; that the server
   gate and the kit agree for every input.
5. **Signing** — auth-entry construction, expiration ledger bounds, signature
   placement, re-simulation after signing.
6. **Device signer and extension pairing** — 7-day Ed25519 co-signer, non-extractable
   key, per-origin grants, pairing origin allowlist (L3).
7. **Replay resistance** — auth-entry nonces and expiry across wallet, policies
   and relayer/sponsor paths.
8. **Seam contract** — diff `vellar-sdk`'s HTTP client against the
   [seam contract](security-audit.md#seam-contract--the-backend-http-api-the-external-vellar-sdk-consumes);
   this closes **RA-11-E** (`/policies/deploy` 422/503 handling) if it matches.
9. **Contract assumptions** — anything the contracts in §3 assume about how the
   SDK builds auth contexts (e.g. which admin calls policies must reject).

---

## 5. Out of scope

- Hosting/platform configuration (V6 dashboard facts). These are operator-owned
  and tracked in `security-audit.md`.
- `vellar-facilitator` and the x402 facilitator plugins, unless the reviewer
  finds the wallet's safety depends on them.
- Marketing sites, the explorer, the VS Code extension.

Anything moved out of scope must be listed here with a reason before the
engagement starts, not after.

---

## 6. Findings format

Use the taxonomy and status legend `security-audit.md` already uses so external
findings sit in the same closing table.

- **Severity:** Critical / High / Medium / Low / Info. Severity is assigned on
  evidence for the mainnet posture, as in the internal audit.
- **Status:** `open`, `closed-by-test`, `closed-by-doc/config`, `deferred`.
  "Closed" without a test whose assertions prove the property is
  `closed-by-doc/config`, not `closed-by-test`.

Each finding records:

| Field           | Content                                                          |
| --------------- | ---------------------------------------------------------------- |
| ID              | `EXT-<n>` (re-review findings: `EXT-RR-<n>`)                     |
| Severity        | As above                                                         |
| Component       | Contract / package / service and path                            |
| Description     | What is wrong                                                    |
| Impact          | What an attacker gains, under what preconditions                 |
| Evidence        | Reproduction, PoC test, or trace                                 |
| Owner           | Named owner                                                      |
| Status          | As above                                                         |
| Fix             | PR / commit                                                      |
| Regression test | Test path and name                                               |
| Review status   | `unreviewed` / `re-reviewed: accepted` / `re-reviewed: reopened` |

### Findings tracker

_Empty until the review starts._

| ID  | Sev | Component | Title | Owner | Status | Fix | Test | Re-review |
| --- | --- | --------- | ----- | ----- | ------ | --- | ---- | --------- |

---

## 7. Remediation and mandatory re-review

```text
engagement → findings → fixes (each test-backed) → external re-review of the fix diff
          → re-review findings (EXT-RR-*) → fixes → … → final report → go/no-go update
```

- One finding, one targeted fix, one regression test. No unrelated refactors in
  remediation PRs; they make the re-review diff unreadable.
- Contract fixes need adversarial unit tests and, where the finding is an
  invariant, a property test. Wallet/API fixes need a seam-crossing or e2e test
  (see RA-9 and RA-11: tests built to match the code rather than the kit hid the
  bugs).
- The re-review is scoped to **the full diff between the reviewed commit and the
  remediated commit**, not only the lines named in findings. RA-1 and RA-11 were
  regressions in code adjacent to a fix.
- Budget and schedule the re-review in the original engagement.

---

## 8. What updates `security-audit.md`, and when

Only after the re-review completes:

- Reviewer, dates, reviewed commit(s), and this scope (with any agreed changes).
- Every `EXT-*` finding in the closing table with final status.
- Remaining-blocker #6 (dependency audit) and RA-11-E, closed or restated with
  evidence.
- The go/no-go, re-derived from evidence. Passing tests or a clean build are not
  evidence for GO.

Until then the go/no-go stays **NO-GO** and this document stays marked
**NOT ENGAGED**.

---

## 9. To unblock (maintainer actions)

1. Decide budget and whether to apply to the Soroban Security Audit Bank.
2. Put §2's questions to candidate firms; select one; record the rationale.
3. Agree this scope in writing with the reviewer (amend §5 if anything is cut).
4. Freeze a tag for the reviewed commit and give the reviewer read access to
   `vellar-sdk` at the matching version.
5. Open one tracking issue per `EXT-*` finding as they arrive.

Related open work: #424 (dependency audit of `vellar-sdk` / `passkey-kit`), #423
(RA-11-E), #463 (exact `vellar-sdk` pin). A contributor self-review of the kit,
however thorough, does not satisfy #415. The requirement is an independent
third party.
