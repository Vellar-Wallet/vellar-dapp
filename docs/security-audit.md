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

_(Remediation order is revised in the V1–V6 follow-up analysis; see that section of the
conversation / a future appendix for the updated mainnet-blocking sequence.)_
