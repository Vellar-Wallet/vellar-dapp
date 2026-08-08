# Vellar Wallet — Pre-Mainnet Security Audit

> **Context for a fresh clone:** `technical-doc.md`, `BUILD-PLAN.md`, `CLAUDE.md`, and
> `docs/decisions.md` are **gitignored** — they exist only in the author's working tree and
> do **not** travel with the repository. This file and [`docs/architecture-analysis.md`](architecture-analysis.md)
> are therefore the **only** architecture/security context a clone receives. Read both.
>
> **Method:** 10 deep investigators (one per priority hunt), each required to read the
> mitigating code before reporting; every finding then adversarially re-verified against the
> actual code (the verifier defaults to *refuting*). 21 findings surfaced — 16 confirmed at
> severity, 5 downgraded, 0 refuted. Read-only: no code was modified to produce this.
>
> **The headline:** the design claim "no app-layer auth is fine because value transfer is
> gated on-chain" holds for **user-fund theft** but fails for one class of side effect the
> chain never sees: **the sponsor account's own spending.** The sponsor is the fee *payer*,
> not the wallet; `__check_auth` governs the auth entries' effects, but nothing on-chain
> restricts *who may make the sponsor pay*. That is where the Critical lives.

Severities were assigned for the **pre-mainnet posture**: the code path is identical for
testnet and mainnet, and the sponsor/relayer paths arm on secret *presence* with no network
gate, so a testnet-only finding today becomes a funded-mainnet finding the moment a mainnet
key is configured.

---

## 🔴 CRITICAL

### C1 — Sponsor is an open fee-payer for arbitrary contract calls `[my code]`

`services/wallet-service/src/sponsor.ts:26-39, 41-104`

`needsSponsorRebuild()` validates only four **structural** properties — parseable, exactly one
op, type `invokeHostFunction`, non-empty auth, every auth entry's credential kind !=
source-account. It never inspects `op.func` (target contract / function) or the auth subject.
`createSponsorSubmitter` then discards the caller's fee source, rebuilds the exact
`{func, auth}` with the **sponsor account as fee payer** at a 10,000,000-stroop (1 XLM)
inclusion-fee ceiling, `prepareTransaction` (re-simulates real fee), sponsor-signs, submits.

- **Attack (zero cost, no auth):** build any single-op `invokeHostFunction` against *any*
  Soroban contract (a DEX, a token, the attacker's own contract) whose auth entry uses
  address credentials, POST to `/wallet/submit`. The sponsor pays the fee. The attacker uses
  the sponsor as a free fee-payer for arbitrary on-chain activity.
- **On-chain gate coverage: NONE.** Paying the fee *is* the side effect; the sponsor is not
  the wallet, so `__check_auth` never sees it and nothing on-chain restricts who uses the
  sponsor as fee payer.
- **Testnet:** free XLM, drains a refillable account — real bug, no loss. **Mainnet:** direct
  unbounded drain of real XLM. Armed purely on `SPONSOR_SECRET_KEY` presence (`index.ts:12`)
  with **no network gate**, despite the "Testnet fee-sponsor" comment (`config.ts:11-12`).
- **Fix (keeps stateless relayer, no app-auth):** in `needsSponsorRebuild`, decode `op.func`
  and reject unless the invoked contract is a Vellar-deployed smart-account the product
  recognizes **and** every address-credential auth subject is that same wallet — make on-chain
  identity the gate. Lower the fee bid from the 1-XLM ceiling to a simulation-derived value.
- **Verify:** POST an `invokeHostFunction` at a non-Vellar contract → rejected, not sponsored;
  a legitimate wallet op still sponsors.

---

## 🟠 HIGH

### H1 — Unauthenticated 1-XLM-per-call financial DoS `[my code]`

`services/wallet-service/src/sponsor.ts:58-60`; `services/policy-service/src/deploy.ts:92,120-122`

Same root as C1, plus a second lever: `/policies/:id/deploy-instance` funds a
`createCustomContract` at `DEPLOY_FEE = 10,000,000` bound to a **caller-supplied wallet
address** (regex-validated only). Per-policyId idempotency exists, but `/policies/generate` is
unmetered so a fresh policyId per deploy defeats it — no total cap.

**The gateway rate limit does not bind:** no `trustProxy` → `req.ip` is the socket peer;
behind Render/Railway ingress it collapses to one shared 120/min bucket (hurts legit users,
does not stop an IP-rotating attacker who gets a fresh 120/min per IP). `X-Forwarded-For`
spoofing to *lower* the count does **not** work (no keyGenerator, XFF untrusted) — the failure
is the opposite. Deploy-instance is the more expensive lever (deploy cost + rent per call).

- **Fix:** C1's scoping + a per-sponsor rolling-window **spend** budget (not request cap)
  backed by Postgres; require the wallet to exist in the wallet repository before spending a
  deploy; lower both fee bids to simulation-derived values.

### H2 — repoUrl SSRF: git clone runs on the host, outside the sandbox `[my code]`

`services/worker-service/src/executor.ts:163`

`repoUrl` is validated only by `z.string().url()` — empirically confirmed (zod 4.4.3) to
accept `http://169.254.169.254/…`, `http://127.0.0.1:6379/`, `file://`, `git://`, `ssh://`.
The `--network=none` isolation is on the **docker build step only**; `git clone` runs on the
**host** via `spawn` with inherited env — no scheme/host allowlist, no `GIT_ALLOW_PROTOCOL`,
ambient host git/SSH credentials.

- **Gated on `VERIFY_BUILD_IMAGE`** (the real executor) — inert in default stub mode, live on
  any real build box: unauthenticated cloud-metadata / RFC1918 / loopback reach.
- **Held mitigations:** submodules not fetched (`--no-checkout`, no `--recurse-submodules`);
  dash-prefix option injection blocked by the URL-scheme requirement; commitHash regex-bounded.
- **Fix:** allowlist `https://` to public hosts only; resolve DNS and re-check against
  RFC1918/link-local (defeat rebinding); pass repoUrl after `--`; `protocol.allow=never` for
  non-https; run the clone itself inside network isolation with no ambient credentials.

### H3 — Blind SSRF upgraded to a read primitive via the public build log `[my code]`

`services/worker-service/src/executor.ts:164`

Clone stdout+stderr is captured into the record's `log`, and `toPublic`
(`verification-service/src/server.ts:229-232`) strips only `sourceArchiveRef`/`lockfileHash` —
`log` is returned by the unauthenticated `GET /verification/:contractId`. git's error output
(redirect targets, resolved host/IP, TLS/`fatal:` server echoes) turns H2's blind SSRF into a
read oracle. Same build-box gating as H2.

- **Fix:** keep a private detailed log; return only a sanitized public status string. Retain
  even after H2 is fixed (defense in depth).

---

## 🟡 MEDIUM

- **M1 — Session enumeration + revocation `[my code]`** — `wallet-service/src/server.ts:163-183`.
  `GET /wallet/sessions?contractId=` lists every session for any *public* contractId;
  `DELETE /wallet/session/:id` revokes any by id — no ownership check. **Verified sessions are
  NOT access tokens** (only consumer is a cosmetic "this device" label + self-disconnect;
  web `connected` state derives from the SDK localStorage store, not the server row), so this
  is device-management DoS + session-graph disclosure, not an authz bypass. **Fix:** authorize
  session read/revoke with the caller's own opaque session id as a bearer capability; stop
  letting a bare public contractId enumerate ids.

- **M2 — deploy-instance has no spend cap of its own `[my code]`** — `policy-service/src/server.ts:156`.
  Sole caller-side throttle is the ineffective gateway per-IP limit; distributed callers drain
  faster than 120/min implies. **Fix:** global/per-sponsor deploy budget in policy-service.

- **M3 — Spending-limit tumbling window allows 2× the limit `[my code]`** —
  `contracts/policy-templates/spending-limit/src/lib.rs:281-284` (identical in token variant
  `:317-320`). Full cap just before reset + full cap just after = 2× across a boundary; the
  documented invariant is off by 2×. Overflow is *safe* (`overflow-checks=true` + `checked_add`,
  panic on None). **Fix:** true sliding window, or document the 2× honestly.

- **M4 — verified-recipient bricks all covered transfers with no live registry `[my code]`** —
  `contracts/policy-templates/verified-recipient/src/lib.rs:184-205`. As a required co-signer it
  rejects the whole auth for any unattested contract; `is_verified` returns false for
  missing/expired records. No mainnet attestation registry is deployed
  (`policy-service/src/templates.ts:48` is a testnet ID), so a `verified_only` policy on mainnet
  rejects every covered transfer. **⚠ See V3 — this may be permanent fund lock, re-rated below.**
  **Fix:** gate `verified_only` out of the mainnet policy builder until a mainnet registry is
  deployed and pinned per-network.

- **M5 — Attestation registry is a single-key oracle `[my code]`** —
  `contracts/attestation-registry/src/lib.rs:124-180`. One `ATTESTOR_SECRET_KEY` compromise
  forges provenance for any contract and can rotate itself away; the entire verified-recipient
  trust layer = one hot G-key on an internet-facing worker. **Fix:** attestor as
  multisig/smart-account so `require_auth` enforces threshold on-chain.
  **Status (FIX 4): DEFERRED behind a hard guard.** M5 is only exploitable once a *mainnet*
  registry exists, and none does — the deployed registry is testnet. Rather than ship an
  untested smart-account attestor now, the worker refuses to wire the single-key attestor
  against a mainnet registry (`assertAttestorSafeForNetwork`,
  `services/worker-service/src/attestor-guard.ts`): boot fails on the mainnet passphrase unless
  `ALLOW_SINGLE_KEY_ATTESTOR=1` is set. The single-key attestor keeps working on testnet. The
  intended design when mainnet is scheduled:
  > **Smart-account attestor.** Make the registry's attestor a Soroban smart-account
  > (C-address) rather than a single G-key. `attestation-registry`'s `upsert`/`revoke`/
  > `set_attestor` already gate on `require_auth(attestor)` (`lib.rs:124-180`), so pointing the
  > stored attestor at a C-address means the account's own `__check_auth` enforces an M-of-N
  > threshold (or a policy) on-chain — no registry-contract change to the auth model. The worker
  > then submits `upsert`/`revoke` *through* that account (co-signing to threshold) instead of
  > signing with a lone keypair (`registry-submitter.ts:39`). A single host compromise is then
  > insufficient to forge provenance. (Ed25519 classic multisig was rejected: Soroban
  > `require_auth` on a G-account checks a single ed25519 signature and does not compose with
  > classic multisig thresholds.)

- **M6 — DB fallback fails open + health lies `[my code]`** — `service-kit/src/index.ts:49-64`,
  `wallet-service/src/index.ts:31-61`. No `DATABASE_URL` (or transient unreachability — Render
  free Postgres expires at 30 days) → silent in-memory repos, `/health` still returns
  `{status:ok}`. Loses audit log, session list, passkey-dedupe on every restart. *Downgraded
  from High:* the map is not the ownership gate (on-chain is), so this is durability / audit-
  integrity / availability, not authz bypass. **Fix:** DB-probing `/health` → 503 when
  in-memory in production; fail-closed boot when `DATABASE_URL` is set-but-unreachable (mirror
  worker-service, which already `exit(1)`s).

- **M7 — No reaper for stranded `building` rows `[my code]`** —
  `worker-service/src/pg-job-store.ts:16-30`, `loop.ts:37-62`,
  `verification-service/src/server.ts:149-190`. A crash mid-build strands a job forever
  (`claimSubmitted` only selects `submitted`); unauthenticated undeduped submit floods the
  single global queue. **Fix:** reclaim `building` rows older than an interval; dedupe/throttle
  submissions per contract; bound retries.

- **M8 — Stale fast-uri override `[dependency]`** — `pnpm-workspace.yaml:24-25`. Override pins
  `4.1.1` but the advisory (GHSA host-confusion) fix is `>=4.1.2`; the vulnerable version is in
  the **live backend** fastify/ajv stack, not just dev tooling. **Fix:** bump override to
  `fast-uri@4: ">=4.1.2"`, regenerate lockfile, add `pnpm audit --audit-level=high` to CI.

- **M9 — Deploy from `main` with tsx, no build/typecheck/audit gate `[my code]`** —
  `services/all-in-one/package.json` (start = `tsx`, no build), `render.yaml:22-23`. Push-
  triggered; CI runs typecheck/test/build but is not wired as a deploy precondition and no
  in-repo branch protection enforces it. *Downgraded from High:* requires push-to-main access
  (insider/token compromise); only committed target is testnet; the self-merge vector was
  **refuted** (`close-prs-*.yml` only *close* PRs — no checkout, no merge). **Fix:**
  `autoDeploy: false`, required status checks on main, `pnpm audit` gate.

---

## 🟢 LOW

- **L1 — `POST /policies/deploy` writes an unverified `deployed` flag from the request body
  `[my code]`** — `policy-service/src/server.ts:206-222`. *No client renders trust from it
  today* (verified: UI shows "attached" only after a real passkey-signed on-chain attach via
  `apps/web/lib/policy.ts:82-93`). Latent; harden before any consumer trusts it. **Fix:** verify
  the txHash on-chain before stamping `deployed`.

- **L2 — Downstream services bind `0.0.0.0:4001-4004` with no middleware `[my code]`** —
  `service-kit/src/index.ts:88`. *Downgraded to Low:* committed configs publish only `$PORT`,
  so not internet-reachable via the public URL today; residual defense-in-depth + shared
  private-network exposure. **⚠ See V4 — composes with H2 when worker is co-located.** **Fix:**
  bind `127.0.0.1` for co-located services; only the gateway binds `0.0.0.0`.

- **L3 — No web-app-origin allowlist on `pair` `[my code]`** — `extension/lib/router.ts:37-39`,
  `background.ts:164-186`. Any site can pair, supply an attacker RPC, and become the extension's
  deep-link target (phishing). Downgraded (needs user to open attacker page; passkey still gates
  signing). **Fix:** env-configured allowlist of canonical Vellar web origins.

- **L4 — Device signing consults attacker-controllable `rpcUrl` for the expiration ledger
  `[dependency]`** — `extension/lib/tx-signer.ts:56-61,83`. Precondition is L3; an inflated
  `getLatestLedger` widens the on-chain validity window for that one signed entry. **Fix:** use
  the extension's own per-network RPC, or pass a locally-bounded explicit expiration.

- **L5 — `normalizeOrigin` accepts trailing-dot FQDNs as distinct principals `[my code]`** —
  `provider-sdk/src/permissions.ts:38-49`. UX confusion only; the browser scopes storage per
  origin so no privilege inheritance. **Fix (optional):** strip a single trailing dot.

- **L6 — Cleanup builder emits all ops into one tx + unpaginated `as`-cast Horizon reads
  `[my code]`** — `lifecycle-service/src/builder.ts:44-103`, `horizon.ts:44-95`.
  Correctness/DoS, **not** fund theft (every tx is unsigned; the user must sign). **Fix:** split
  by `OPS_PER_TX=100`; add fetch timeouts; paginate/validate Horizon responses.

- **L7 — 14 high dependency advisories (0 critical) `[dependency]`** — `pnpm-workspace.yaml:16`.
  Most reachable ones config-mitigated (no http2 → find-my-way DoS inert). **Fix:** add
  `pnpm audit` to CI; bump `next` to `>=16.2.11`; update the wxt dev chain.

---

## ℹ️ INFO

- **I1 — Attacker-controlled PR filenames rendered into the bot comment body `[my code]`** —
  `.github/workflows/close-prs-outside-contrib.yml:31-42`. Markdown injection, **no code
  execution**. Both `close-prs-*.yml` do no checkout, run only parameterized `github-script`,
  and there is **zero `${{ }}` interpolation** across all workflows — the RCE class is absent.
  **Fix:** escape filenames before embedding; do **not** add a checkout step.

---

## Remediation order

**Before any mainnet key is configured (blocking):**
1. **C1** — scope the sponsor to Vellar wallet operations (the one place the on-chain gate does
   not cover the side effect; direct drain of real funds).
2. **H1 / M2** — sponsor spend budget + lower fee bids + wallet-must-exist check for deploys.
3. **M5** — attestor as multisig/smart-account before any mainnet registry goes live.
4. **M4** — gate `verified_only` out of the mainnet policy builder until a mainnet registry
   exists (see V3 re-rating).

**Before public testnet exposure (a real build box / public submit endpoint):**
5. **H2 + H3** — repoUrl allowlist + private build logs.
6. **M1** — authorize session read/revoke with the caller's own session id.
7. **M6** — fail-closed boot + DB-aware health.
8. **M8** — bump fast-uri.

**Can wait (hardening / latent):** M3, M7, M9, L1–L7, I1.

_(Remediation order is revised in the V1–V6 follow-up below.)_

---

## V1–V6 Follow-up — deeper verification of the load-bearing claims

Six questions that could change the remediation plan were traced to code (two via investigators
reading the pinned passkey-kit source and the installed `passkey-kit@0.14.0` derivation code).
Verdicts below; three of them changed the plan.

### V1 — `/wallet/create` derivation gate is available. **CONFIRMED**

The create tx goes to the **relayer**, not the sponsor: `createHybridSubmitter`
(`wallet-service/src/index.ts:17-25`) routes to the sponsor only when
`needsSponsorRebuild` is true (`sponsor.ts:26-39`), and a wallet deploy carries
**source-account (deployer) auth**, so the predicate is false → relayer fallback.

The smart-account address is a **secret-free pure function of the keyId** under the pinned
scheme (`node_modules/…/passkey-kit/dist/utils.js:28-37`):
`salt = sha256(keyId)`; `deployer = Keypair.fromRawEd25519Seed(sha256("kalepail"))`
(`constants.js:56`, public, no secret); `contractId = StrKey.encodeContract(sha256(HashIdPreimage{
networkId: sha256(passphrase), fromAddress(deployer, salt)}))` — **wasm hash is not an input**.
The client uses this default deployer (`apps/web/lib/connector-factory.ts:57-61`, no `deploySource`).
Every input is in the create body (`keyId`) or a pinned constant, so the server can reject unless
`deriveContractAddress(keyId, pinnedDeployer, pinnedPassphrase) === body.contractId` — a one-line
check using the **already-exported** symbol at `passkey-kit/dist/index.js:31`. Today
`server.ts:76-107` does none of this. This is the same invariant the keyId "client-authoritative"
refutation rested on, so **the refutation stands and the fix and the refutation are one fact.**

> **⚠ Limitation of the derivation gate — do NOT read `existsByContractId` as authentication.**
> FIX 2 proves only that `contractId == derive(keyId)`, i.e. it binds the address to the keyId. It
> does **not** prove a genuine WebAuthn authenticator exists or that a real user controls the key: a
> scripted P-256 keypair produces a perfectly valid self-authored deploy and a matching
> `derive(keyId)` contractId. So a "recognized wallet" (a row in the wallets table, checked by
> `WalletRepository.existsByContractId`) is a **metering and scoping primitive only** — it bounds
> *which* contracts the funding paths will pay for, and lets budgets attribute spend to a wallet. It
> is **never** an identity, trust, or ownership signal, and no future code may treat it as one
> (e.g. to gate a sensitive action, render a "verified user" badge, or skip an on-chain check). The
> only real authority remains the passkey signature validated on-chain by `__check_auth`.

### V2 — The relayer is a second unscoped funding source. **CONFIRMED**

`createHybridSubmitter` sends anything failing `needsSponsorRebuild` to the **relayer**
(`sponsor.ts:114-117`), funded by `RELAYER_API_KEY`, reachable unauthenticated via the same
routes. **C1's sponsor-only scoping does not cover the relayer branch** — scoping must happen at
the route, before the submitter selects a branch, or the abuse simply relocates to the relayer.

### V3 — M4 is NOT permanent fund lock. **REFUTED → M4 stays Medium (availability)**

The pinned smart-wallet source is readable
(`~/.cargo/git/checkouts/passkey-kit-…/50981cc/contracts/smart-wallet/src/lib.rs`).
`remove_signer` runs **no policy code** (`:302-308`, explicit comment that calling the policy
there would let a rejecting policy block its own removal), and `__check_auth` has an
`is_sole_self_removal` exception that **skips consulting a policy** when the only context is that
policy's own removal (`:433-449`, `context.rs:15-45`). In this repo the policy attaches as a
standalone `SignerLimits(None)` signer (`connector-factory.ts:107-124`), so the admin passkey
removes it alone. Recovery = one `remove_signer(SignerKey.Policy(<addr>))` — **but there is no
wired detach UI** (`policy.ts` exposes only attach/deploy), so recovery today needs a direct
`kit.remove(...)` SDK call. **This safety depends on the attach shape**, which is app code, not
the contract — so a test must pin it.

### V4 — H2+L2 do NOT compose into sponsor spend. **REFUTED (as spend) / CONFIRMED (as reachability)**

A co-located worker's host-side `git clone` (`executor.ts:163`, `defaultRun` = host `spawn`,
`:292-294`) **can** reach `http://127.0.0.1:4001/4003`, but git smart-HTTP clone issues a **GET**
and every sponsor-spending route is **POST-only** (`server.ts:128,156`) — so no unauthenticated
spend via clone. It **does** confirm the worker reaches internal-only ports the internet cannot,
and H3 reads them back out. **Do not encode "POST-only" as a control** — fix the reachability
(bind `127.0.0.1`, isolate the worker, allowlist repoUrl).

### V5 — `network` is a label, not a routing input. **CONFIRMED**

RPC/passphrase are fixed from env at process start (`config.ts:18-19`); the request `network`
field is used only for storage/metrics/lookup (`server.ts:68,102-105,116,137-138,169`), never for
submission routing. **Rule for all remediation guards: key off server config only, never the
request body's `network`.**

### V6 — Two infra facts remain gated on the dashboard

From committed configs: neither `render.yaml` nor `railway.json` publishes any port beyond the
injected `$PORT`, and neither sets an `autoDeploy`/branch/trigger field. **Provable from repo:**
the repo never asks to expose 4001-4004. **NOT provable from repo (needs dashboard):** whether the
platform edge firewalls the other bound listeners, and whether `autoDeploy` is on. Both manifests
are testnet-only.

### Revised mainnet-blocking order

1. **Scope both funding paths at the route** (C1 + H1 + V2). Validate the tx is a Vellar wallet
   op before the submitter selects sponsor *or* relayer; lower the sponsor fee bid to
   simulation-derived.
2. **Derivation gate on `/wallet/create`** (V1). Reject unless `derive(keyId) === contractId` —
   closes create as a third funding path and enforces the client-authoritative invariant.
3. **Per-path spend budgets** keyed off server config only (H1/M2/V5); meter `/policies/generate`
   or budget on spend; require the wallet to exist before a sponsored deploy.
4. **Attestor as multisig/smart-account** before any mainnet registry (M5).
5. **Policy attach invariant + detach path** (V3): pin the standalone-signer attach shape with a
   test; wire detach into the web app.
6. **Worker network isolation** (H2+H3+L2+V4): bind downstream to `127.0.0.1`; repoUrl allowlist
   with DNS re-check; split public/private build logs.

**Dropped from blocking:** M4 (availability-only per V3; gate `verified_only` out of the mainnet
builder + add detach UI when that path is enabled).
**Still gated on dashboard (V6):** final severity of L2 (port exposure) and M9 (autoDeploy).
