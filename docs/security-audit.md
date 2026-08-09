# Vellar Wallet — Pre-Mainnet Security Audit

> **Context for a fresh clone:** `technical-doc.md`, `BUILD-PLAN.md`, `CLAUDE.md`, and
> `docs/decisions.md` are **gitignored** — they exist only in the author's working tree and
> do **not** travel with the repository. This file and [`docs/architecture-analysis.md`](architecture-analysis.md)
> are therefore the **only** architecture/security context a clone receives. Read both.
>
> **Method:** 10 deep investigators (one per priority hunt), each required to read the
> mitigating code before reporting; every finding then adversarially re-verified against the
> actual code (the verifier defaults to _refuting_). 21 findings surfaced — 16 confirmed at
> severity, 5 downgraded, 0 refuted. Read-only: no code was modified to produce this.
>
> **The headline:** the design claim "no app-layer auth is fine because value transfer is
> gated on-chain" holds for **user-fund theft** but fails for one class of side effect the
> chain never sees: **the sponsor account's own spending.** The sponsor is the fee _payer_,
> not the wallet; `__check_auth` governs the auth entries' effects, but nothing on-chain
> restricts _who may make the sponsor pay_. That is where the Critical lives.

Severities were assigned for the **pre-mainnet posture**: the code path is identical for
testnet and mainnet, and the sponsor/relayer paths arm on secret _presence_ with no network
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

- **Attack (zero cost, no auth):** build any single-op `invokeHostFunction` against _any_
  Soroban contract (a DEX, a token, the attacker's own contract) whose auth entry uses
  address credentials, POST to `/wallet/submit`. The sponsor pays the fee. The attacker uses
  the sponsor as a free fee-payer for arbitrary on-chain activity.
- **On-chain gate coverage: NONE.** Paying the fee _is_ the side effect; the sponsor is not
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
spoofing to _lower_ the count does **not** work (no keyGenerator, XFF untrusted) — the failure
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

> **Status (FIX 6): CLOSED.** Implemented in `services/worker-service/src/repo-url-guard.ts` +
> `executor.ts`. The guard requires public `https`, rejects userinfo, resolves the host once,
> and refuses any answer in a private/loopback/link-local range (incl. `169.254.169.254`,
> RFC1918, IPv6 loopback/link-local, IPv4-mapped). It **returns the validated IP**, which the
> executor pins into git's connection so the check and the connection agree **by construction,
> not by timing**:
>
> - **Connection pinned:** `-c http.curloptResolve=<host>:443:<ip>` (libcurl `CURLOPT_RESOLVE`)
>   forces git to connect to the exact address the guard validated — git does **not** re-resolve
>   the hostname. This substitutes the address only; **TLS SNI + certificate validation still use
>   the hostname**, so the pin does not open a MITM window (verified against git 2.50.1's
>   `http.curloptResolve` semantics).
> - **Redirects forbidden:** `-c http.followRedirects=false` turns any 30x into an error, so the
>   remote cannot bounce git to a different, unpinned host that it would resolve freely. (This is
>   chosen over re-running the guard per redirect target — an error is simpler and strictly
>   safer for a verification clone, which never legitimately needs a cross-host redirect.)
> - Plus `protocol.allow=never` + `protocol.https.allow=always` and `repoUrl` after `--`.
>
> A test asserts a host whose DNS flips public→private between the guard's resolution and the
> clone connects to the pinned **public** IP (or fails), never the private one. The rebinding
> TOCTOU window is therefore closed.
>
> **Stronger alternative (for later):** when the worker gets its own dedicated host, run the
> clone inside a network namespace that can only reach public routes — that removes reliance on
> the git/libcurl pin entirely and also covers any non-HTTP fetch path. Not required now; the
> pin + redirect-block fully closes the HTTPS clone path this executor uses.

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
  `GET /wallet/sessions?contractId=` lists every session for any _public_ contractId;
  `DELETE /wallet/session/:id` revokes any by id — no ownership check. **Verified sessions are
  NOT access tokens** (only consumer is a cosmetic "this device" label + self-disconnect;
  web `connected` state derives from the SDK localStorage store, not the server row), so this
  is device-management DoS + session-graph disclosure, not an authz bypass. **Fix:** authorize
  session read/revoke with the caller's own opaque session id as a bearer capability; stop
  letting a bare public contractId enumerate ids.

  > **Status (M1/RA-3): CLOSED.** The session routes are now gated on a bearer session capability
  > (`Authorization: Bearer <sessionId>`), and — importantly — **the premise this finding was rated
  > on has changed:** a session id is no longer "not an access token." It is now a **narrow bearer
  > capability** for the session routes (list / read / revoke), scoped to the account it is bound to,
  > with a 7-day sliding expiry (matching the device signer; expired == absent). It authorizes ONLY
  > those routes — a non-drift test asserts a valid session id grants nothing on `/wallet/submit` or
  > `/wallet/create` — so it does not become the app-layer auth the design omits. The reasoning that
  > depended on "sessions gate no authority" is superseded (see the architecture-analysis update);
  > the impact-if-leaked is now bounded by expiry and by the capability's narrow scope, and the id no
  > longer appears in a logged URL (routes moved the id to the header/body) or in the audit log (a
  > truncated `sha256` ref is stored, never the raw id). Enumeration/mass-revoke are closed:
  > listing/revoke require a live capability for that exact account.

- **M2 — deploy-instance has no spend cap of its own `[my code]`** — `policy-service/src/server.ts:156`.
  Sole caller-side throttle is the ineffective gateway per-IP limit; distributed callers drain
  faster than 120/min implies. **Fix:** global/per-sponsor deploy budget in policy-service.

- **M3 — Spending-limit tumbling window allows 2× the limit `[my code]`** —
  `contracts/policy-templates/spending-limit/src/lib.rs:281-284` (identical in token variant
  `:317-320`). Full cap just before reset + full cap just after = 2× across a boundary; the
  documented invariant is off by 2×. Overflow is _safe_ (`overflow-checks=true` + `checked_add`,
  panic on None). **Fix:** true sliding window, or document the 2× honestly.

  > **Status (FIX 10): CLOSED by documentation — behavior UNCHANGED.** This is a product
  > decision, resolved as "keep tumbling, fix every claim" (Option B). The contract is not
  > modified; the 2× boundary property is now stated honestly everywhere and PINNED by tests:
  >
  > - The contract module doc (`spending-limit/src/lib.rs:18-23`) now describes the FIXED
  >   (tumbling) window and the up-to-2×-across-a-boundary behavior explicitly.
  > - Two tests assert the property in BOTH directions
  >   (`spending-limit/src/test.rs`: `boundary_allows_up_to_two_times_limit` and
  >   `boundary_does_not_allow_more_than_two_times_limit`). A future change to the reset logic
  >   (e.g. to a sliding window) breaks the first test — flagging that the documented contract
  >   changed, in either direction.
  > - The UI copy was corrected: the policy-builder header, the spending-limit card description,
  >   and the review-step paragraph (`apps/web/app/policies/page.tsx`), plus the template registry
  >   source of truth (`services/policy-service/src/templates.ts` — description AND comments).
  >   The `apps/docs/` "rolling window" mislabels are corrected in a separate docs commit.
  >
  > **Why Option A (sliding window in the contract) was REJECTED:** a sliding window is a new
  > wasm hash, so **existing deployed policy instances keep tumbling semantics until detached and
  > re-attached** — Option A would split users across two different guarantees with **no external
  > way to tell which a wallet has** (the deployed contract id doesn't reveal the semantics). It
  > also adds storage + gas on every guarded transfer. Given the docs already recommend pairing
  > this policy with an authenticated co-signer for a hard cap, the 2× is a bounded, documented
  > guardrail property, not a defect. **Revisit A only if the spending limit ever becomes a
  > standalone security boundary rather than a co-signer-paired guardrail.**
  >
  > **UI-vs-docs asymmetry worth knowing:** the UI header claimed an EXTERNAL AUDIT the policy
  > contracts have not had ("Policies come from audited templates … not by a promise"). No audit
  > report exists in the repo or git history; the only audited artifact is the external
  > kalepail/passkey-kit smart wallet, which these policies depend on but did not write (the
  > contracts even self-disclaim "audited" — `verified-recipient/src/lib.rs:16`,
  > `attestation-registry/src/lib.rs:14`). By contrast, `apps/docs/` was already accurate — it
  > correctly attributes the audit to passkey-kit and says the policy contract is "testnet only,
  > not yet audited for mainnet." The docs were written carefully; the UI string was not. **Takeaway:
  > review UI strings whenever a contract's behavior is documented — that's where overclaims slip in.**

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
  **Status (FIX 4): DEFERRED behind a hard guard.** M5 is only exploitable once a _mainnet_
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
  > then submits `upsert`/`revoke` _through_ that account (co-signing to threshold) instead of
  > signing with a lone keypair (`registry-submitter.ts:39`). A single host compromise is then
  > insufficient to forge provenance. (Ed25519 classic multisig was rejected: Soroban
  > `require_auth` on a G-account checks a single ed25519 signature and does not compose with
  > classic multisig thresholds.)

- **M6 — DB fallback fails open + health lies `[my code]`** — `service-kit/src/index.ts:49-64`,
  `wallet-service/src/index.ts:31-61`. No `DATABASE_URL` (or transient unreachability — Render
  free Postgres expires at 30 days) → silent in-memory repos, `/health` still returns
  `{status:ok}`. Loses audit log, session list, passkey-dedupe on every restart. _Downgraded
  from High:_ the map is not the ownership gate (on-chain is), so this is durability / audit-
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
  in-repo branch protection enforces it. _Downgraded from High:_ requires push-to-main access
  (insider/token compromise); only committed target is testnet; the self-merge vector was
  **refuted** (`close-prs-*.yml` only _close_ PRs — no checkout, no merge). **Fix:**
  `autoDeploy: false`, required status checks on main, `pnpm audit` gate.

  > **Status (FIX 11): PARTIALLY CLOSED — repo-side done, two settings remain manual.**
  > Done in-repo on this branch:
  >
  > - **`pnpm audit --audit-level=high` added to CI** (`.github/workflows/ci.yml`, after Install):
  >   a newly-introduced high/critical advisory now blocks the build. Currently green (FIX 8 took
  >   the count to 0 high).
  > - **`autoDeploy: false` on the Render service** (`render.yaml`): Render no longer ships every
  >   push to `main`; deploy is a manual/tagged action after CI passes.
  >
  > **Remains MANUAL (cannot be set from a committed file — dashboard/settings only):**
  >
  > 1. **GitHub branch protection on `main`** — mark the `ci` check (and, if desired,
  >    `pnpm audit`) as a **required status check**, and require PRs (no direct pushes). This is
  >    a repo Settings → Branches value; nothing in the repo can enforce it.
  > 2. **Railway `autoDeploy`** — `railway.json` has no autoDeploy field; Railway's auto-deploy is
  >    a dashboard setting. If Railway is a live target, turn it off there too (or confirm Render
  >    is the only deploy target and Railway is unused).
  > 3. **Confirm which platform is actually live** (V6, still open) — the gate only matters on the
  >    platform that deploys. If only Render is live, item 2 is moot.
  >
  > Until the branch protection (item 1) is set, CI is a signal, not a gate — a maintainer can
  > still merge red. The repo-side changes make the gate _possible_; the dashboard settings make
  > it _binding_.

---

## 🟢 LOW

- **L1 — `POST /policies/deploy` writes an unverified `deployed` flag from the request body
  `[my code]`** — `policy-service/src/server.ts:206-222`. _No client renders trust from it
  today_ (verified: UI shows "attached" only after a real passkey-signed on-chain attach via
  `apps/web/lib/policy.ts:82-93`). Latent; harden before any consumer trusts it. **Fix:** verify
  the txHash on-chain before stamping `deployed`.

  > **Status (FIX 12/L1): CLOSED by verification, NOT by removal.** The field is kept (it is the
  > canonical "this policy is now attached" record `deployPolicy` returns), but `/policies/deploy`
  > now **decodes the client-supplied tx and confirms it actually attached THIS policy to THIS
  > wallet** before stamping `deployed` (`services/policy-service/src/verify-attach.ts`):
  >
  > - The tx must exist and have SUCCEEDED on the **server-config network** (the lookup is bound to
  >   config's RPC, never the request body — V5), invoked `add_signer`/`update_signer` on the
  >   record's **wallet**, and carry the record's **policy contract id** in the signer args (found
  >   by recursively scanning the ScVal args, so the address inside the nested `Signer::Policy`
  >   enum is matched). The wallet is now persisted on `record.instance` at `/deploy-instance` so
  >   there is something to verify against.
  > - **Two failure modes are distinguished** so an operator can tell "can't reach chain" from
  >   "you lied": `AttachUnconfirmedError` → **503** (RPC unreachable or tx NOT_FOUND — fail closed,
  >   retryable, not stamped); `AttachMismatchError` → **422** (tx FAILED, or attached a different
  >   policy/wallet, or is an unrelated call — a definite lie).
  >
  > **Why the "exists + succeeded" check was REJECTED:** that only defeats `txHash: "00…"`. Any
  > successful hash on the network passes, and the chain is a public list of those (our own docs
  > publish testnet hashes) — the attacker's cost goes from typing zeros to copy-pasting. Worse, it
  > would hand a future consumer a field that _looks_ verified and isn't, so the next person won't
  > re-derive the weakness. Same standard as **FIX 2**: verify that the tx equals the expected
  > attach, not that it is a plausible tx. Tests: an unrelated same-network tx → 422; a tx attaching
  > a different policy → 422; this policy to a different wallet → 422; the legit flow → 200; RPC
  > unreachable → 503 (not stamped).

- **L2 — Downstream services bind `0.0.0.0:4001-4004` with no middleware `[my code]`** —
  `service-kit/src/index.ts:88`. _Downgraded to Low:_ committed configs publish only `$PORT`,
  so not internet-reachable via the public URL today; residual defense-in-depth + shared
  private-network exposure. **⚠ See V4 — composes with H2 when worker is co-located.** **Fix:**
  bind `127.0.0.1` for co-located services; only the gateway binds `0.0.0.0`.

- **L3 — No web-app-origin allowlist on `pair` `[my code]`** — `extension/lib/router.ts:37-39`,
  `background.ts:164-186`. Any site can pair, supply an attacker RPC, and become the extension's
  deep-link target (phishing). Downgraded (needs user to open attacker page; passkey still gates
  signing). **Fix:** env-configured allowlist of canonical Vellar web origins.

  > **Status (FIX 12/L3): CLOSED.** `routeProviderRequest` now gates `pair` on a fail-closed
  > web-app-origin allowlist (`apps/extension/lib/pair-origins.ts` + `router.ts`); an off-list
  > origin is refused `unauthorized` **before any approval popup**, so an attacker page can never
  > become `webAppOrigin` or seed the paired `rpcUrl` (which closes L4's precondition).
  >
  > The allowlist is resolved **fail-closed, matching FIX 7's boot posture** — it does not
  > silently degrade the way the in-memory DB fallback would:
  >
  > - **Trust signal:** the dev/prod split keys off `import.meta.env.COMMAND` (`"build"` vs
  >   `"serve"`), which WXT/Vite **injects at bundle time per artifact** — a _runtime_ env var
  >   cannot spoof it, unlike a `NODE_ENV` read. (`import.meta.env.MODE` would work too;
  >   `COMMAND` is the WXT-native, typed one in `.wxt/types/globals.d.ts`.)
  > - **Dev build, nothing configured:** falls back to `http://localhost:3000` / `:5173` only.
  > - **Production build, nothing configured:** `pairOriginPolicy()` **throws**; the background
  >   worker catches it and sets the policy to `[]` — **pairing is disabled**, not opened to
  >   localhost or to any origin. An unconfigured prod artifact simply cannot pair.
  > - **Escape hatch is named + warned, never silent:** `WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN=1`
  >   (same shape as `ALLOW_INMEMORY` / `ALLOW_SINGLE_KEY_ATTESTOR`) disables the restriction and
  >   logs a warning on every startup; it is in no committed manifest.
  > - Origins come from `WXT_PUBLIC_WEB_APP_ORIGINS` (comma-separated), each canonicalized through
  >   `normalizeOrigin` (a single trailing slash tolerated; paths/junk dropped); documented in
  >   `apps/extension/README.md`.
  >
  > Tests (`pair-origins.test.ts`, `router.test.ts`): dev+empty → localhost only; prod+empty →
  > throws (no fallback); prod+origins → exactly those; a non-listed origin → refused in both
  > modes; the `"any"` escape hatch → any origin may pair.

- **L4 — Device signing consults attacker-controllable `rpcUrl` for the expiration ledger
  `[dependency]`** — `extension/lib/tx-signer.ts:56-61,83`. Precondition is L3; an inflated
  `getLatestLedger` widens the on-chain validity window for that one signed entry. **Fix:** use
  the extension's own per-network RPC, or pass a locally-bounded explicit expiration.

  > **Status (FIX 12/L4): CLOSED.** Both halves of the fix are applied: the anchor now comes from
  > a **trusted per-network RPC** and the window is **explicitly capped**, so the caller-supplied
  > `wallet.rpcUrl` is entirely out of the expiration path (`apps/extension/lib/signer-expiration.ts`
  >
  > - `tx-signer.ts`).
  >
  > passkey-kit, given no explicit `expiration`, calls `getLatestLedger()` on `wallet.rpcUrl` and
  > sets `signatureExpirationLedger = latest + timeout/5` (verified in `passkey-kit@0.14.0`
  > `kit/tx-ops.js:26,49-57`); it only asserts the result is a u32, no upper bound. `signAuthEntry`
  > accepts an explicit `expiration` and, when supplied, **never calls `getLatestLedger`** — so we
  > supply one:
  >
  > - **Trusted anchor (Option C).** `resolveTrustedRpcUrl` returns SDF's pinned
  >   `https://soroban-testnet.stellar.org` for testnet, and the build-time
  >   `WXT_PUBLIC_MAINNET_RPC_URL` for mainnet — neither is the paired `rpcUrl`. Mainnet with no
  >   configured RPC **fails closed** (`TrustedRpcUnavailableError`); the anchor fetch itself
  >   propagates transport errors rather than falling back to the caller endpoint. Chosen over
  >   reading the tx's own ledger bounds (Soroban txs often carry none, and a control that rejects
  >   correct transactions gets removed by whoever hits it first).
  > - **Capped window.** `boundedExpirationLedger` adds **exactly `MAX_EXPIRATION_LEDGERS = 60`**
  >   (~5 min at ~5s/ledger) — the ADDED span is never anchor-proportional, so an inflated anchor
  >   cannot widen it — clamped to u32. 60 is a deliberate approval-latency-vs-replay-window
  >   tradeoff: it must cover the worst realistic approval (user gets the popup, switches apps,
  >   returns, approves), and the replay exposure traded away is small — the device key is already
  >   a 7-day expiring co-signer, further bounded by attached policies.
  > - **Nothing else in the signing path trusts `wallet.rpcUrl` for a security-relevant value.**
  >   `connectWallet` uses it to confirm the wallet exists and the keyId is a signer, but the
  >   wallet binding is re-asserted locally (`kit.contractId === wallet.address`, and `contractId`
  >   is a deterministic local derivation, not an RPC claim), and a lying "you are a signer" cannot
  >   forge a signature — the device key signs and the real network validates at submit. Only the
  >   expiration is baked into the signed payload, and that is what this fix removes from the RPC.
  >
  > Tests (`signer-expiration.test.ts`, `tx-signer.test.ts`): the added span is always exactly the
  > cap regardless of anchor size; the cap is 60; mainnet with no RPC throws and signs nothing; the
  > wired signer fetches the anchor from the pinned testnet endpoint (asserted `!= wallet.rpcUrl`)
  > and passes the capped `expiration` to `signAuthEntry`.

- **L5 — `normalizeOrigin` accepts trailing-dot FQDNs as distinct principals `[my code]`** —
  `provider-sdk/src/permissions.ts:38-49`. UX confusion only; the browser scopes storage per
  origin so no privilege inheritance. **Fix (optional):** strip a single trailing dot.

  > **Status (FIX 12/L5): CLOSED.** `normalizeOrigin` now collapses a single trailing dot on the
  > host (`app.example.com.` → `app.example.com`) by stripping it from `url.hostname` and letting
  > the URL recompute the origin (so host + port stay consistent). The existing bare-origin guard
  > (`url.origin !== value`) still runs first, so a dotted host with a path/query is rejected before
  > the strip, exactly as before. Only ONE dot is removed — a doubled dot stays distinct, since we
  > canonicalize the one real FQDN convention, not arbitrary garbage. Tests (`permissions.test.ts`):
  > the dotted and dotless forms map to the same normalized origin (incl. with an explicit port and
  > on `localhost.`); a doubled trailing dot is not collapsed to the clean form.

- **L6 — Cleanup builder emits all ops into one tx + unpaginated `as`-cast Horizon reads
  `[my code]`** — `lifecycle-service/src/builder.ts:44-103`, `horizon.ts:44-95`.
  Correctness/DoS, **not** fund theft (every tx is unsigned; the user must sign). **Fix:** split
  by `OPS_PER_TX=100`; add fetch timeouts; paginate/validate Horizon responses.
  - **L6b — "Safe account cleanup" copy overclaim `[my code]`** — `apps/web/app/page.tsx:46`
    (live landing) names the cleanup feature "Safe account cleanup." Cleanup **moves funds and
    merging classic accounts is irreversible**, so "safe" is a claim, not a label. Surfaced while
    fixing M3's overclaims (grep for "safe"). Handle the copy in the same pass as the L6 cleanup-
    builder work (right context — the builder + its promise reviewed together). The gitignored
    `landing-page/VELA Landing.html` has the same string but does not ship; leave it.

  > **Status (FIX 12/L6): CLOSED.** All four parts fixed, with the L6b copy in the same pass so the
  > builder and its user-facing promise stay in agreement.
  >
  > - **Op-split.** `buildCleanupSteps` (`lifecycle-service/src/builder.ts`) now collects every
  >   cleanup operation and splits by `OPS_PER_TX = 100` — Stellar's hard protocol limit (a 101-op
  >   tx is rejected with `txTOO_MANY_OPS`; the SDK does not guard it client-side, so the old
  >   single-tx build silently produced an invalid tx for >100-op accounts, despite the "can re-run
  >   the wizard" comment). Split transactions share one `Account` source, so they carry
  >   **consecutive sequence numbers** and the user signs/submits them in order; each step is
  >   titled `(n/total)`.
  > - **Planner agreement.** `buildCleanupPlan`'s `estimatedTransactions` now counts the REAL op
  >   count (a "N open offers" blocker is one row but N cancel ops; a non-zero balance is two ops),
  >   so the estimate no longer under-reports the number of transactions the builder emits.
  > - **Horizon reads validated + paginated + timed out.** `createHorizonAccountReader`
  >   (`horizon.ts`) replaces the `as`-casts with **zod** runtime validation (a malformed body
  >   throws a clear "Horizon … was malformed" error, not a cryptic `.map of undefined` in the
  >   builder), follows `_links.next` to collect **all** offer pages (the old `?limit=200` read
  >   only the first page, so a >200-offer account would clean up incompletely and fail the merge),
  >   guards against a self-referential `next` (stops on an empty page, capped at `maxOfferPages`),
  >   and wraps every request in an `AbortController` **timeout** so a hung Horizon can't stall.
  > - **L6b copy.** The landing card is retitled **"Guided account cleanup"** and its body now
  >   states plainly that closing an account moves its funds and can't be undone — the honest
  >   guarantee (guided, reviewable, you sign every step), not "safe". The gitignored landing HTML
  >   is left as-is (does not ship).
  >
  > Tests: `builder.test.ts` (no step exceeds 100 ops; 250 ops → 3 txs summing to 250; consecutive
  > sequences; non-zero balance = 2 ops); `server.test.ts` (150 offers → 3 transactions estimate;
  > 100 non-zero balances → 3); `horizon.test.ts` (404 → undefined; non-ok → throws; malformed body
  > → clear error; offers collected across pages; empty-page guard; timeout aborts).

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

**Before public testnet exposure (a real build box / public submit endpoint):** 5. **H2 + H3** — repoUrl allowlist + private build logs. 6. **M1** — ~~authorize session read/revoke with the caller's own session id~~ **DONE** (RA-3/M1: bearer session capability, 7-day sliding expiry, hashed audit ref). 7. **M6** — fail-closed boot + DB-aware health. 8. **M8** — bump fast-uri.

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
> _which_ contracts the funding paths will pay for, and lets budgets attribute spend to a wallet. It
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
   op before the submitter selects sponsor _or_ relayer; lower the sponsor fee bid to
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

---

## Re-audit of the patched tree (RA) — findings introduced or missed by the remediation

Method: after #228 + #230 merged, the patched tree was re-audited **read-only**, treating all
remediation code as untrusted new surface. Nine parallel hunts (SSRF guard, derivation gate,
route-scoping, spend budget, escape hatches, FIX-12 paths, policy-attach invariant, closure-by-test,
standard sweep); every candidate then adversarially re-verified against the actually-installed code
(the verifier defaulted to _refuting_). Nine findings survived verification. The two Highs sit on the
**funding path** — the exact controls the mainnet gate depends on.

### RA-1 — Route scope gate matches only the **V1** credential string; passkey-kit 0.14 signs **V2** 🔴 High `[my code]`

`services/wallet-service/src/scope.ts:43`; same defect in `apps/extension/lib/tx-signer.ts:101`.

`extractAddressAuthSubjects` filters auth entries with `entry.credentials().switch().name !==
"sorobanCredentialsAddress"` — an exact match on **V1** only. But the production signer
`passkey-kit@0.14.0` **never emits V1 for a signed wallet op**: `kit/tx-ops.js:45` calls
`toAddressBoundCredentials`, which `kit/auth-payload.js:65-67` upgrades every entry **in place** to
`sorobanCredentialsAddressV2`, and `tx-ops.js:46-48` throws unless the payload is V2/with-delegates
("there is deliberately NO V1 signing path"). `@stellar/stellar-sdk@16.0.1` `curr_generated.js:1726-1731`
confirms the enum has V1(1)/V2(2)/with-delegates(3). Two failures:

- **(b) fail-closed BREAK (live on testnet today):** a normal single-op V2-signed wallet tx yields
  `subjects === []` → `assertScopedToKnownWallets` throws `ScopeError('no_wallet_subject')` →
  **HTTP 403 on every legitimate `/wallet/submit`** in the production posture (the gate is live
  whenever `deps.networkPassphrase` is set — `server.ts:203-207`, wired from server config at
  `index.ts:100-111`). Every post-deploy wallet operation is rejected the moment the gate is enabled.
- **(a) scope BYPASS:** a mixed tx with one V1 entry bound to a known wallet + one V2 entry bound to
  an attacker contract yields `subjects === [known]` (V2 skipped at line 43), passes the gate, and
  `needsSponsorRebuild` routes it to the funded sponsor rebuild `{func, auth:[A,B]}` — the V2 leg
  rides past the C1/H1/V2 scope control.

The suite is green only because `scope.test.ts` builds solely V1 / source-account fixtures — the V2
path is never exercised (see the fixture-defect note in RA notes). The identical V1-only filter in
`tx-signer.ts:101` means the extension signer would skip the real V2 entries and sign nothing.

> **Status (RA-1): CLOSED.** `scope.ts` and `tx-signer.ts` now resolve the `SorobanAddressCredentials`
> across **all three** address-bound arms (`sorobanCredentialsAddress` V1, `sorobanCredentialsAddressV2`,
> `sorobanCredentialsAddressWithDelegates` → `.addressCredentials()`) and read `.address()` uniformly;
> source-account is skipped. Fixtures are now kit-shaped: the test builders default to **V2** (the real
> signer output — `toAddressBoundCredentials` upgrades V1 in place) and parametrize over v1/v2/delegates,
> so a V1-only regression fails immediately. `scope.test.ts` adds the mixed V1(known)+V2(attacker) bypass
> case at both the extract and `assertScopedToKnownWallets` levels (the attacker V2 leg is now surfaced
> and rejected); `tx-signer.test.ts` asserts each variant is signed. 13 scope tests + 62 extension tests
> pass; both packages typecheck.

### RA-2 — Spend-budget conditional INSERT is not atomic under READ COMMITTED 🔴 High `[my code]`

`packages/service-kit/src/pg-budget.ts:41`.

`tryConsume` runs check-and-record as a single `WITH agg AS (SELECT SUM(count)/SUM(stroops) FROM
spend_ledger WHERE line/network/at>windowStart) INSERT … SELECT … WHERE agg.sum + N <= max`
statement. The aggregate CTE takes **no row locks** (no `FOR UPDATE`), the INSERT writes a fresh
`randomUUID` row against only a **non-unique** `(line,network,at)` index, and `db/client.ts:19` is a
bare `pg.Pool` with **no isolation override** (default READ COMMITTED; no SERIALIZABLE / `FOR UPDATE`
/ advisory lock anywhere in the repo). N concurrent requests each snapshot the same committed sum,
all pass the `WHERE`, all commit → the ceiling degrades from a hard cap to **ceiling + pool
concurrency**.

`budget.ts:2-4` documents this cap as the **sole** binding funding-path control (the gateway per-IP
limit does not bind — no `trustProxy`). So the overshoot is a direct drain of real sponsor XLM past
the FIX-3 ceiling: fire 8 concurrent `/wallet/submit` (or `/wallet/create` / `/policies/deploy` —
all share `createPgSpendBudget`) against a maxCount=1 boundary → up to 8 sponsored txs land. The
concurrency test that would catch it (`pg-budget.test.ts:112-127`) is `describe.skipIf(!TEST_DATABASE_URL)`
and does not run in ordinary CI, so the atomicity guarantee is **unverified** and would fail against
real Postgres.

> **Status (RA-2): CLOSED.** `pg-budget.ts` now runs the check+insert inside a **transaction**
> guarded by `pg_advisory_xact_lock(hashtext('<line>:<network>'))` **taken before the aggregate
> read**, so same-`(line,network)` callers serialize (lock auto-released at commit) and different
> keys never block each other. Chosen over a unique counter row (would force a tumbling window,
> re-introducing M3's boundary leak in our own ledger) and over SERIALIZABLE+retry (retry loops +
> aborts on the funding hot path).
>
> **A second defect surfaced and was fixed:** the existing concurrency test was **decorative**. It
> both (a) skipped locally behind `skipIf(!TEST_DATABASE_URL)` and (b) fired `Promise.all` over a
> single drizzle pool, which serializes on the pool and never actually raced — so it passed even
> against the broken single-statement code. Proven with real parallel connections (12 own-connection
> consumers, ceiling 1): the old single statement inserted **10 rows** (overshoot); the advisory-lock
> version inserts exactly **1**. The test is rewritten to use N independent single-connection pools
> so it truly races — it now **fails against the pre-fix code and passes with the lock** (verified
> against Postgres 16 via `infra/docker`). Unit tests (`budget.test.ts`, no DB) additionally pin that
> the lock statement is issued **first**, inside a transaction, keyed on `hashtext(line:network)`.
>
> **CI now enforces the guarantee runs:** the workflow already provisions Postgres and passes
> `TEST_DATABASE_URL`; it also sets `CI_REQUIRE_DB=1`, under which the DB integration suites **fail
> rather than silently skip** if the DB ever goes missing — so "the guarantee only holds when a local
> env var is set" can no longer be true in CI. The false "ONE atomic statement" claim in `budget.ts`
> is corrected.

### RA-3 — M1 (session enumeration + revocation) is still OPEN; the doc's own status is stale 🟡 Medium `[my code]`

`services/wallet-service/src/server.ts:254-274`.

`GET /wallet/sessions` (`:254-261`) and `DELETE /wallet/session/:id` (`:263-274`) read only
query/params and enforce **no** ownership or bearer credential. An unauthenticated attacker who
learns a victim's public C-address (it is on-chain) can enumerate every active session id + metadata
(`GET …?contractId=<victim>`), then `DELETE` each → log the victim out of all devices. M1 has **no**
"Status: CLOSED" block and still sits on the pre-exposure checklist (Remediation order item 6), yet
its Fix ("authorize read/revoke with the caller's own opaque session id as a bearer capability") was
never implemented. Impact is bounded — sessions gate **no** on-chain authority (authorization is
on-chain via `__check_auth`; web connected-state derives from SDK localStorage) — so this is device-
management DoS + session-graph disclosure, **not** an authz bypass.

> **Status (RA-3): CLOSED (branch `security/session-capability`).** Implemented as a bearer session
> capability, and the finding's own premise ("sessions gate no authority") was updated everywhere it
> was reasoned from, not just where it was stated:
>
> - **Guard.** `GET /wallet/sessions`, the new `GET /wallet/session` (own session), and the new
>   `POST /wallet/sessions/revoke` all require `Authorization: Bearer <sessionId>` resolving to a
>   **live** session **bound to the exact account** being read/revoked. Missing / unknown / expired /
>   wrong-account bearer all return an identical `401 unauthorized`, so no response reveals whether an
>   id was ever valid. Enumeration and cross-account mass-revoke are closed.
> - **Expiry.** Sessions now carry `expires_at` (schema migration `0002`) and expire on a **7-day
>   sliding window** matching the device signer (`SESSION_TTL_MS`; noted in-code that the two
>   lifetimes are coupled). `find`/`listByContract` treat an expired row as **absent**; `touch` slides
>   `lastActiveAt`+`expiresAt` only on an authorized use, so a rejected/expired id cannot extend its
>   own life. This fixes the pre-existing never-updated `lastActiveAt` (it was harmless for a label,
>   not for a capability).
> - **No credential in logs.** The id moved out of the URL (path/query) into the header/body —
>   Fastify logs URLs but not headers/bodies — and the audit log stores a **truncated `sha256(id)`**
>   ref, never the raw id.
> - **No auth drift.** A non-drift test asserts a valid session id on `Authorization` grants nothing
>   on `/wallet/submit` or `/wallet/create` (they still validate their own bodies) — the capability
>   stays narrow and does not become the app-layer auth the design deliberately omits.
> - **Premise sweep.** The "not an access token / gates no authority" reasoning in
>   `docs/architecture-analysis.md` (the "What passes for a session" + "Where authorization is real"
>   passages) and in the M1 finding above was corrected — a conclusion built on the old premise, not
>   just the sentence, so a later reader doesn't re-derive the stale rating.
>
> **⚠ CORRECTION (RA-11, branch `security/session-client-seam`): "CLOSED" above was SERVER-ONLY.**
> The scoped re-audit of this surface found the M1 commit reshaped the server routes but **orphaned
> the web client** — `listSessions` sent no bearer (permanent 401) and `revokeSession` DELETEd the
> removed route and swallowed the 404 as success (revoke was a silent fail-open no-op). The guard was
> correct but _unreachable by the real client_, and the client's mocked-fetch tests pinned the broken
> behavior. Fixed under RA-11 with a **seam-crossing** test (real client ↔ real `buildServer`). The
> server-side facts in this block hold; the feature is only now delivered end-to-end.

### RA-4 — `ALLOW_INMEMORY` fail-closed boot guard is **inert** on the deploy targets 🟡 Medium `[my code]`

`packages/service-kit/src/persistence.ts:29,41,56`.

`isProduction` is a strict `nodeEnv === "production"` and gates both fail-closed branches. The
deployed process (`@vellar/all-in-one`) starts via `tsx … src/index.ts` with **no `NODE_ENV`**, and
**no committed config** (`render.yaml` envVars, `railway.json`, `.env.example`) sets it — confirmed
by repo-wide grep; neither platform injects it by default. So at runtime `isProduction(undefined) ===
false`: when `DATABASE_URL` is set but unreachable, the guard falls through to `allow-inmemory` and
`/health` reports ok. This **silently undoes FIX 7 (M6) on the actual deploy target** — and
`render.yaml:8` warns the free Postgres **expires at 30 days**, exactly the DB-gone failure mode
where audit log, sessions, and the FIX-3 spend budgets would reset to volatile in-memory while
health monitoring says healthy. Downgraded High→Medium only because both manifests are testnet-only.

> **Status (RA-4): CLOSED — by inverting the default, not by patching the manifest.** Setting
> `NODE_ENV=production` in the deploy config would work only until the next target that forgets it —
> a missing env var still meaning "less safe" is the bug. Instead the polarity is inverted: in
> `packages/service-kit/src/persistence.ts`, in-memory is now the branch that requires an **explicit**
> signal, and **absence fails closed**:
>
> - `resolvePersistencePolicy` degrades to in-memory only on an **explicitly ephemeral** env
>   (`NODE_ENV === "development" | "test"`) or the operator opt-in `ALLOW_INMEMORY=1`. An **unset**
>   `NODE_ENV` — the deploy-target reality — no longer degrades; with no usable durable DB it returns
>   `fail` and the service `process.exit(1)`s. The wallet- and policy-service call sites feed
>   `process.env.NODE_ENV` straight in, so they inherit the fix.
> - Local dev keeps working because the `dev` scripts now set `NODE_ENV=development` explicitly
>   (7 services), and Vitest sets `NODE_ENV=test`; the deployed `start` scripts stay unset, so they
>   fail closed unless a DB is wired (which `render.yaml`/`railway.json` do) or `ALLOW_INMEMORY=1` is
>   set. The signal is now the presence of an explicit dev marker, never the absence of a prod one.
> - A regression test pins the exact deploy-target case (`nodeEnv: undefined` + no/unreachable DB →
>   `fail`) that had no coverage before.
>
> **Repo-wide inertness sweep (per the RA-4 directive "if this one was wrong, others likely are").**
> 19 environment-signal checks audited; 7 were the same "unset ⇒ less-safe" shape. Dispositions:
>
> - **Fixed here (same NODE_ENV persistence class):** `persistence.ts` (the anchor) + its wallet/
>   policy call sites (auto-fixed). **`verification-service/index.ts` was the worst case** — it had
>   **no `resolvePersistencePolicy` and no NODE_ENV backstop at all**, always silently falling back to
>   an in-memory store on unset/unreachable DB; it now uses the same fail-closed policy.
> - **New latent finding, filed as RA-10 (separate mechanism, not fixed here):** `attestor-guard.ts:16`
>   keys the mainnet single-key guard on an **exact passphrase match**, so an unset
>   `STELLAR_NETWORK_PASSPHRASE` defaults to testnet and **silently bypasses** the M5 guard if a worker
>   is pointed at mainnet without setting the passphrase. Requires the attestor to be enabled; tracked
>   for the M5 work.
> - **Already-documented conditional guards (not new):** the sponsor/relayer scoping
>   (`wallet-service/server.ts:109`, wired only when the relayer is configured) and the L1
>   attach-verify (`policy-service/server.ts:97`, wired only when RPC is available) are "absent config
>   ⇒ skip guard" in shape, but both are intended — the guarded funding/deploy path is itself inert
>   without that config. The `VERIFY_BUILD_IMAGE` stub switch is loud + already documented. No change.
> - **Confirmed CORRECT (fail-closed) — do not touch:** the extension's `import.meta.env.COMMAND`
>   (unset ⇒ `build`/strict), `WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN`, `ALLOW_SINGLE_KEY_ATTESTOR`, worker
>   `DATABASE_URL`, and the gateway CORS/rate-limit/body-cap defaults. The extension is the reference
>   for the right shape: absence yields the safe branch.

### RA-10 — Network classification derived from a passphrase that defaults to testnet (a CLASS, 3 services) 🟡 Medium `[my code]`

_Originally filed as "attestor-guard mainnet check bypassed by an unset passphrase" (Info, tracked
with M5). The fix's broadened sweep showed it is not one site but a **class** — a security decision
derived from a value whose default is the permissive side — present in **three** services. Re-rated
Medium and closed as a class._

`services/worker-service/src/attestor-guard.ts:16`. `attestorNetwork` returns `"mainnet"` only on an
**exact** `MAINNET_PASSPHRASE` match; an unset `STELLAR_NETWORK_PASSPHRASE` defaults to the testnet
passphrase (`config.ts:53`), so a worker pointed at a mainnet RPC/registry while forgetting the
passphrase mis-classifies as testnet and the single-key-on-mainnet refusal (M5) **silently does not
run**. Surfaced by the RA-4 inertness sweep. Same class as RA-4 (unset ⇒ less-safe) but a different
signal (network passphrase, not `NODE_ENV`), and it only bites when the attestor is enabled
(`ATTESTOR_SECRET_KEY` + `ATTESTATION_REGISTRY_ID` set).

> **Status (RA-10): CLOSED (branch `security/attestor-guard-hardening`) — as a guard-correctness
> fix, decoupled from M5.** RA-10 was a defect in the guard that _holds the line_ until M5 is built,
> not the M5 decision itself; a guard that fails open on a missing value must be sound BEFORE a
> mainnet cutover, not fixed as part of it — so it was fixed on its own branch, not folded into M5.
>
> **Root cause addressed, not just the symptom.** The guard inferred "which network" from
> `networkPassphrase` — a value whose real job is signing and which **defaults to the testnet
> string**. Rather than make that inference fail closed (which would keep deriving a security
> decision from a signing value with a permissive default — the exact class the sweep exists to
> eliminate), the network is now an **explicit, required** setting:
>
> - **`resolveNetwork` (`worker-service/src/network-config.ts`)** reads `STELLAR_NETWORK`
>   (`testnet | mainnet`), **required with NO default** — a missing value **refuses to boot**, it
>   never resolves to the permissive side. The passphrase/RPC keep their signing/connection defaults,
>   but the _security signal_ is `STELLAR_NETWORK`, which has none.
> - **Mutual cross-check, both directions.** The declared network is verified coherent with the
>   passphrase and the RPC host. It refuses when `testnet` is declared but the passphrase/RPC look
>   like mainnet, AND when `mainnet` is declared but they look like testnet — a mismatch either way
>   means the config is incoherent and the worker does not guess which half is right. An
>   _unrecognized_ passphrase/RPC is treated as a disagreement (can't positively confirm → fail
>   closed). (Contract ids are network-agnostic, so the registry can't be value-checked — only the
>   passphrase and RPC host carry a network signature.)
> - **Loud at boot, naming the disagreeing values.** `NetworkConfigError` lists which of the
>   passphrase / RPC disagreed, so an operator hitting this at cutover knows exactly what to fix.
>   `configFromEnv` calls it at load; `index.ts` surfaces it and `process.exit(1)`s.
> - **The attestor guard no longer classifies the network** — `assertAttestorSafeForNetwork` takes
>   the resolved `Network` directly. `STELLAR_NETWORK=testnet` is set in the worker's dev script and
>   `render.yaml` (alongside the existing passphrase/RPC), so local dev and the committed config stay
>   coherent.
>
> Verified end-to-end against the real `configFromEnv`: missing `STELLAR_NETWORK` → refused;
> coherent testnet → boots; testnet-declared + mainnet RPC → refused (names the RPC); mainnet-declared
>
> - default (testnet) passphrase → refused (names the passphrase). Tests: `network-config.test.ts`
>   (10 cases incl. both mismatch directions, unknown network, unrecognized passphrase, and naming all
>   disagreeing values), `attestor-guard.test.ts` (M5 refusal given a known network).
>
> **RA-10 is a CLASS, closed across all three services it appears in.** A broadened sweep (below) —
> for any security decision derived from a value whose default is the permissive side, not just the
> env-flag shape RA-4 looked for — found the SAME passphrase-defaults-to-testnet inference in two more
> places, both labelling a spend-budget ledger line:
>
> - `wallet-service/src/index.ts` — `budgetNetwork` was `passphrase === DEFAULTS ? "testnet" :
"mainnet"`. A mainnet wallet-service that forgot the passphrase would meter its **mainnet** sponsor/
>   create spend against the **testnet** budget line — testnet and mainnet sharing one ceiling, so the
>   per-network cap isn't enforced per network.
> - `policy-service/src/index.ts` — identical, for the deploy budget line (and `deps.network`, which
>   flows into the L1 verify-attach decode).
>
> Both now derive the network from the shared `resolveNetwork` (promoted to **`@vellar/service-kit`**
> so all three services use one implementation) off the explicit, required `STELLAR_NETWORK`, cross-
> checked and fail-closed. **`STELLAR_NETWORK=testnet` added to the wallet + policy dev scripts** (the
> deploy already sets it in `render.yaml`, and the all-in-one process — which imports both services —
> is covered by that one setting).
>
> **Why boot-refusal is the right strictness here, not accidental inheritance of the worker's gate:**
> the wallet/policy sites label a budget ledger, which is milder than the worker's mainnet security
> gate — but a service that **cannot coherently tell which network it is on must not spend on a
> funding path** (V5 already requires guards to key off server config). Converting a silent
> mislabel into a loud boot failure is correct: the failure surfaces the misconfiguration at deploy
> time instead of letting mainnet spend accrue against a testnet ceiling. **No ledger migration is
> needed** — the label is per rolling window, so any old-scheme rows age out; only new spend is
> classified by the explicit signal. **Local dev and the deploy manifests are covered** (dev scripts
>
> - `render.yaml` set `STELLAR_NETWORK=testnet`); a service that boots without it now fails loudly
>   rather than assuming testnet.

### Broadened permissive-default sweep — the class, enumerated

Sweep scope: every defaulted value feeding a security decision across `services/`, `packages/`,
`apps/` (non-test). Broader than RA-4's env-flag sweep — RA-10 hid from that one because it gates on
a **value's content** (a passphrase string), not a flag's presence. **22 sites classified; 3 were the
unsafe permissive-default class (all the RA-10 network-label instances above, now closed); the rest
are correct.** The dominant pattern is sound: numeric caps/limits/timeouts/TTLs default to **finite,
restrictive** values (the control is ON out of the box), and unaccountable states fail closed.

| Verdict                                | Sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Note                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **unsafe-permissive-default** (closed) | `wallet-service/index.ts` budgetNetwork, `policy-service/index.ts` budgetNetwork, `policy-service/server.ts` verify-attach network                                                                                                                                                                                                                                                                                                                                                                                             | The RA-10 class — all three now use `resolveNetwork`. |
| **already-fixed**                      | `persistence.ts` (NODE_ENV, RA-4 inversion), `network-config.ts` (STELLAR_NETWORK, RA-10), `ALLOW_INMEMORY` (defaults off), worker `config.ts` passphrase (neutralized by the cross-check)                                                                                                                                                                                                                                                                                                                                     | Prior fixes.                                          |
| **safe-default** (12)                  | `ALLOW_SINGLE_KEY_ATTESTOR` (off), gateway `CORS_ORIGIN` (specific localhost, not `*`), `RATE_LIMIT_*` (120/min on), `MAX_BODY_BYTES`/`REQUEST_TIMEOUT_MS` (1 MiB / 30s), `BUDGET_*` ceilings (finite; unaccountable → `createUnavailableBudget` refuses), `SPONSOR_MAX_FEE_STROOPS` (0.1 XLM tight), docker sandbox caps (timeout/mem/cpu/pids finite + `--network=none`), `VERIFY_QUEUE_MAX_ACTIVE`, attestation TTL/reap/attempts, extension pair-origins + `WXT_PUBLIC_MAINNET_RPC_URL` (fail-closed), web `NEXT_PUBLIC_*` | Default is the restrictive side; verified, no change. |
| **not-a-security-decision** (3)        | `HORIZON_URL`, provider-sdk request timeout, extension `WXT_PUBLIC_API_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Defaulted but feeds no security decision.             |

Rule going forward (the class): **never derive a security decision from a value whose default is the
permissive side.** If a decision needs a signal, make the signal explicit and required, fail closed on
its absence, and cross-check any value that has to keep a default for another purpose (like a
passphrase needed for signing).

> **⚠ CORRECTION (RA-11): the sweep missed a 4th related site — a DIFFERENT axis of the same class.**
> This sweep hunted _defaulted-value_ network inference. But `wallet-service`'s **create** budget line
> keyed its network off the **request body** (`parsed.data.network`), not off config — a
> _body-vs-config_ variant of "a security decision trusting an untrusted/wrong source." It survived
> because it wasn't a `?? default` shape. Found by the #232 re-audit (H-3), fixed under RA-11: the
> create line now meters on `deps.budgetNetwork` (from `resolveNetwork`), and **all three
> `tryConsume` sites are re-confirmed to key off server config** (sponsor, create, policy-deploy). The
> rule generalizes: a network/security label must come from server config, whether the risk is a
> permissive _default_ or a trusted _request body_.

### RA-5 — Cleanup builder pays the full asset balance **before** cancelling offers (ignores selling liabilities) 🟡 Medium `[my code]`

`services/lifecycle-service/src/builder.ts:59` (+ `horizon.ts` never parses `selling_liabilities`).

`collectCleanupOps` emits every non-native payment at `amount = balance.balance` (the **full**
trustline balance) and its trustline removal, and only **afterward** the offer cancels — so payments
always precede cancels in the op list. For an account holding an asset it also has an open offer
selling (100 USDC held, 40 USDC on offer), the payment of 100 hits the 40 locked as a selling
liability → `op_underfunded` → whole tx `txFAILED`. Guided cleanup can never complete for a common
real account state, and the wizard surfaces a raw `op_underfunded`. No fund loss (txs are unsigned)
and the `/lifecycle/merge` preflight re-inspects live state (409 while blockers remain), so no
irreversible merge on partial cleanup — a liveness/correctness bug, not a safety one. Untested.

> **Status (RA-5): CLOSED.** `collectCleanupOps` now emits **offer cancels first**, then balance
> payouts + trustline removals, then data deletes (`builder.ts`). Cancelling first frees the selling
> liabilities, so by the time each payment runs (ops execute sequentially within the tx) the full
> asset balance is spendable — no `op_underfunded`. Chosen over parsing `selling_liabilities` and
> subtracting it from the paid amount: reordering makes the tx correct by construction (the liability
> is gone before the payment), whereas subtracting would leave the liability-locked remainder stranded
> on the account and still block the trustline removal — so parsing `selling_liabilities` was
> considered and deliberately not needed. Tests (`builder.test.ts`, `server.test.ts`): an account
> holding an asset it also sells on an open offer emits the cancel before the payment (asserted every
> `manageSellOffer` precedes every `payment`), and the end-to-end op order is now
> `manageSellOffer → payment → changeTrust → manageData`.
>
> **⚠ CORRECTION (RA-11): "end-to-end" was builder-only.** The re-audit found the cleanup WIZARD
> consumer signed only `steps[0]` of a multi-transaction split (>100 ops) and dead-ended at a 409
> merge, so end-to-end cleanup was NOT delivered for large accounts. The builder ordering + split
> are correct (safety held — no fund loss, merge preflight fail-closed); the wizard is fixed under
> RA-11 to walk every chunk, with a multi-chunk e2e proven to catch the drop.

### RA-6 — V3 detach invariant is pinned only at the pure helper; the attach/detach wiring is untested 🟡 Medium `[my code]`

`apps/web/lib/connector-factory.ts:123`.

V3's refutation of permanent fund lock holds **only** because the policy attaches as a standalone
`SignerLimits(None)` signer, triggering the wallet's `is_sole_self_removal` exception on detach. That
fund-lock-critical shape lives entirely in the pure helper `policyAttachArgs`; `policy-signer.test.ts`
asserts only the helper in isolation, `policy.test.ts` drives detach through a `vi.fn` fake (never the
real `kit.remove(SignerKey.Policy(...))`), and the L1 backend verifier deliberately does **not** check
the `SignerLimits` shape. So a plausible future edit — making `verified_only` a co-signer inside
another key's `SignerLimits` map, as the verified-recipient doc-comment contemplates — would ship
**green** and re-introduce the V3 permanent-fund-lock (a reject-everything policy could then block its
own removal). No live bypass today; a test-coverage gap on a fund-lock-critical invariant.

> **Status (RA-6): CLOSED.** The attach/detach wiring is extracted from `connector-factory.ts` into
> `createPolicySignerActions` (`apps/web/lib/policy-signer.ts`) and unit-tested with a fake kit at the
> WIRING layer, not just at the pure `policyAttachArgs`. The tests assert what the kit is actually
> called with: `attachPolicy` calls `kit.addPolicy(id, limits, store, expiration)` with
> **`limits === undefined`** (standalone `SignerLimits(None)` — the shape that triggers the wallet's
> `is_sole_self_removal` exception), `store = Persistent`, no expiration; `detachPolicy` calls
> `kit.remove(SignerKey.Policy(id))` (the exact key the recovery exception recognizes). Crucially,
> `connector-factory` now **delegates to that same `createPolicySignerActions`**, so the production
> path is the tested path — the refactor the finding feared (inlining a `SignerLimits` map to make the
> policy a required co-signer) would now break these tests instead of shipping green. The browser-only
> `SignerKey`/`SignerStore` enums are injected, keeping the action module SSR/test-safe.
>
> **⚠ CORRECTION (RA-11): the "production path is the tested path" claim is slightly too strong.**
> The re-audit's L-3 found the `connector-factory → createPolicySignerActions` DELEGATION edge itself
> is untested (no `connector-factory` test exists; the helper is imported directly), so a refactor
> that _abandons_ the helper and inlines a `SignerLimits` map would still ship green. The wiring
> assertion inside `createPolicySignerActions` is real and load-bearing; the residual gap is the thin
> forwarding wrapper. Low — tracked as RA-11/L-3, a cheap follow-up on a fund-lock invariant.

### RA-7 — `isBlockedAddress` misses hex-form IPv4-mapped + NAT64 IPv6 ℹ️ Info `[my code]`

`services/worker-service/src/repo-url-guard.ts:64`.

As a pure unit, `isBlockedAddress` returns `false` for `::ffff:7f00:1` (127.0.0.1), `::ffff:a9fe:a9fe`
(169.254.169.254), and `64:ff9b::a9fe:a9fe` (NAT64) — the line-64 regex catches only the dotted
`::ffff:d.d.d.d` form. **Downgraded to Info** (from a claimed Low): no reachable failure today —
`new URL` keeps IPv6 literals bracketed, so `isIP` returns 0, the literal branch is skipped, and
`dns.lookup` of the bracketed string throws ENOTFOUND (fail-closed); the only production resolver
emits IPv4-mapped answers in the dotted form the regex does catch. Latent defense-in-depth: it
defends only a hypothetical future refactor that strips brackets before the literal check.

> **Status (RA-7): OPEN (latent).** Canonicalize IPv6 to bytes and range-check embedded IPv4-mapped
>
> - NAT64 rather than string-prefix matching. Low urgency; no live path.

### RA-8 — Audit hygiene: M3 / M4 / M5(deferral) / M8 / M9 are **not** code-fixed closures ℹ️ Info

Reporting risk, not a runtime defect. A reviewer tallying "closed by passing test" must not count
these: **M3** leak behavior is unchanged — the tests pin the _documented_ 2× tumbling-window property
(`spending-limit/src/test.rs:276` passes ~2× across a boundary); **M4** is product-gated + the V3
recovery path, no mainnet registry; **M5** is a boot-refusal guard only (`attestor-guard.ts`), **not**
a threshold attestor — a single `ATTESTOR_SECRET_KEY` compromise still forges provenance the moment
`ALLOW_SINGLE_KEY_ATTESTOR` is set; **M8** is a lockfile/override pin, no test; **M9** committed
`autoDeploy:false` + the `pnpm audit` gate, but branch-protection / Railway toggles remain manual
dashboard settings. Classify each as closed-by-doc / deferred / config-only, never closed-by-test.

> **Status (RA-8): informational.** No code change; ensures the closure ledger stays honest.

### RA-9 — Fixture-defect pattern: XDR-decoding tests built to match the code, not the kit ℹ️ Info → drives RA-1 `[my code]`

RA-1 is a **test-fixture failure as much as a code failure** — `scope.test.ts` built **V1**
credential fixtures, so the suite validated the V1-only bug instead of catching it. Auditing every
XDR-decoding assertion added in remediation for the same pattern (does the fixture match what
`passkey-kit@0.14.0` really produces, or what the implementation happens to parse?):

| Remediation                     | Fixture site                                                                                        | Verdict                                                | Kit-shape change that slips past                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FIX 2** derivation gate       | `derivation.test.ts:17` (pinned deployer, verified against the kit) + live `deriveWalletContractId` | **KIT-DERIVED (robust)**                               | none kit-shaped; a real seed/deployer drift breaks the pinned-pubkey assertion loudly                                                                                                                                                                                                                                                                                                                                                        |
| **FIX 1** `needsSponsorRebuild` | **no fixture at all** — `sponsor.test.ts` covers only `enforceFeeCap` / `consumeSponsorBudget`      | **UNTESTED**                                           | any change to the credential-type filter — nothing asserts on V2, the `sourceAccount` exclusion, or the one-op/invokeHostFunction/has-auth guards. (The filter is a _negative_ `!== sorobanCredentialsSourceAccount` check, so it accepts V2 correctly _today_ — safe by luck, not by test.)                                                                                                                                                 |
| **L1** attach-tx decode         | `verify-attach.test.ts:34-38` `buildAddPolicyXdr`                                                   | **CODE-SHAPED (same defect class as `scope.test.ts`)** | the helper builds a **3-element** `[Symbol('Policy'), Address, Void]` vec, but the kit's real `Signer::Policy` is a **5-element** tuple `[Symbol('Policy'), Address, Vec[Void], Vec[Void], Vec[Symbol('Persistent')]]`. It passes only because `collectAddresses` scans for the address _anywhere_ in the args and the function name is correct. A kit change to where the address is embedded breaks production while the test stays green. |

Three instances of the pattern (scope.test.ts + L1 + FIX-1's absence). Only FIX 2 builds its fixture
the way the kit actually produces the value.

> **Status (RA-9): CLOSED.** All three instances of the pattern closed:
>
> - **RA-1 (scope + tx-signer):** fixtures default to **V2** and parametrize v1/v2/delegates — a
>   V1-only regression fails (see RA-1).
> - **FIX-1 `needsSponsorRebuild`:** now has a test (`sponsor.test.ts`) — the predicate is exercised
>   with real V2/V1/delegates address credentials (→ route to sponsor), source-account and mixed
>   address+source (→ false), plus multi-op / empty-auth / non-invoke / unparseable guards. A
>   regression to a positive V1-only check now fails.
> - **L1 `buildAddPolicyXdr`:** rebuilt to the kit's **real 5-element** `Signer::Policy` tuple
>   `[Symbol('Policy'), Address, SignerExpiration::None, SignerLimits::None, SignerStorage::Persistent]`
>   (matching `passkey-kit` `buildPolicySigner` + the `passkey-kit-sdk` `Signer` UDT), replacing the
>   hand-built 3-element vec. A new assertion pins the tuple **arity** so a kit encoding drift is
>   visible; the decode path still finds the policy address in the realistic shape.
>
> `passkey-kit-sdk` is only a transitive dep here, so the fixtures reproduce the kit's on-the-wire
> shape element-for-element rather than importing the `Spec` directly; each is tied to the kit source
> lines it mirrors. Rule going forward: any test asserting on a decoded passkey-kit XDR shape must be
> built from (or pinned against) the real kit shape, never hand-fit to the parser.

### RA-11 — Server↔client SEAM DRIFT: contract changes shipped without updating (or seam-testing) the consumer 🔴 High `[my code]`

A **scoped re-audit of the #232 session surface** (M1 introduced a bearer capability to a design with
no app-layer auth — the same category that produced RA-1/RA-2) found the server-side capability
**genuinely sound** (narrow scope, expiry-as-absence, no window-slide-on-reject, no leakage, hashed
audit ref verified) — but the **client** was orphaned, and the pattern turned out to span multiple PRs.
This is the sibling of RA-9: **RA-9 was tests asserting what the code does rather than what the
_library_ produces; RA-11 is tests asserting what each _side_ does rather than what the two sides
_agree on_.** A contract change between server and client needs a test that crosses the seam.

Findings (fixed on branch `security/session-client-seam`):

- **RA-11-A [High] — M1 orphaned the web session client (#232).** `apps/web/lib/http-backend.ts`:
  `listSessions` sent no `Authorization` bearer → the M1 guard 401s → the device list never rendered;
  `revokeSession` called the **removed** `DELETE /wallet/session/:id` → 404 → and **swallowed the 404
  as success** → every user-initiated revoke was a silent fail-open no-op on the lost/compromised-device
  path. The client's mocked-fetch tests pinned exactly this (asserting the removed URL + 404-as-success).
  **Fix:** the client sends the bearer, `revokeSession` POSTs `/wallet/sessions/revoke` with
  `{targetSessionId}` + bearer and **throws on any non-2xx** (the 404-swallow is gone; audited the rest
  of `http-backend` — the only other status special-case, `lookupContractId`'s 404→undefined, is a
  legitimate "unknown passkey" semantic, kept). The mocked-fetch session tests are **replaced by a
  seam-crossing integration test**: the real client driven against the real `buildServer` (Fastify
  `inject`→fetch adapter), covering every session route — **proven to catch the original bug** (reverting
  to the old client fails 3 seam tests the old mocked tests passed). Added `@vellar/wallet-service/server`
  subpath export + web devDep + the `passkey-kit` vitest inline-deps the server import needs.
- **RA-11-B [High] — create budget metered on the request body, not server config (H-3, V5).** Covered
  in the RA-10 sweep correction above: `wallet-service` create line keyed off `parsed.data.network`, so
  an attacker POSTing a mismatched `network` split relayer-funded create spend across the
  testnet/mainnet partitions (2× the effective ceiling). **Fix:** meter on `deps.budgetNetwork` from
  `resolveNetwork`; all three `tryConsume` sites re-confirmed config-keyed.
- **RA-11-C [Medium] — cleanup wizard dropped split chunks (M-1).** Covered in the RA-5 correction:
  the wizard signed only `steps[0]` of a >100-op split and dead-ended at a 409 merge. **Fix:** the wizard
  walks every chunk (progress "Transaction n of m") before merging; a multi-chunk e2e proves it.
- **RA-11-D [Low] — a SECOND orphan from a DIFFERENT PR (#229).** The route-drift enumeration (run
  because RA-11-A proved the class isn't PR-scoped) found #229's H3/FIX 6 stopped exposing the raw build
  `log` on the verification API (it leaked host paths / internal IPs) and returns a sanitized
  `statusDetail` — but `packages/verification-sdk`'s `PublicVerificationRecord` still declared `log?` and
  omitted `statusDetail`, and `apps/web/app/verify/page.tsx` rendered a "Show build log" toggle behind
  `record.log` (silently gone; `statusDetail` unreachable). Graceful degradation, not a crash. **Fix:**
  SDK type + verify page consume `statusDetail`.
- **RA-11-E [Low, residual] — `/policies/deploy` client not verifiable in-repo (#230).** L1 added
  422/503 failure modes to `/policies/deploy`; its client lives in the **external** `vellar-sdk` npm
  package (not in this repo), so its handling **cannot be confirmed here**. Flagged for review against
  the separate `vellar-sdk` repo — if that client assumes 2xx, it's a candidate third orphan.

Route-drift enumeration verdict (all 5 PRs): the wallet `/create` + `/submit` new 403/503 modes are
**correctly** handled by the web client's typed-error path; `/wallet/session*` (RA-11-A) and the
verification `log` field (RA-11-D) were orphaned; `/policies/deploy` (RA-11-E) is external-only.

> **Status (RA-11): A/B/C/D CLOSED (branch `security/session-client-seam`), each with a test proven to
> catch its bug; the seam-crossing test is the durable fix — it makes the whole class recur-proof for
> the wallet session routes. E (external SDK) and the RA-6/L-3 delegation-edge gap remain as flagged
> follow-ups.** Lesson recorded: **any server↔client contract change needs a seam-crossing test; a
> mocked-fetch client test can only assert what the client does.**

### Re-audit bottom line

- **Closed by passing test (verified by reading assertions):** C1/H1/V2, V1 derivation gate, H2, H3,
  M2, M6-readiness, M7, L1, L3, L4, L5, L6/L6b; RA-1, RA-2, RA-9 (#231); RA-4, RA-10 + the
  network-label class (#233); RA-3/M1, RA-5, RA-6 **server-side** (#232); **RA-11-A/B/C** (client seam,
  create-budget V5, cleanup-chunk walk) + **RA-11-D** (verification `statusDetail`), each with a
  seam-crossing or bug-catching test (#`security/session-client-seam`).
- **Closed by doc/config/deferral (NOT code-fixed):** M3, M4, M5, M8, M9 (see RA-8).
- **Open / partial:** RA-7 (latent IPv6, Info); RA-11-E (`/policies/deploy` external `vellar-sdk`
  client — unverifiable in-repo); RA-6/L-3 (connector-factory delegation-edge test — cheap follow-up);
  RA-3's L-1/L-2/L-5 (list-route inject-clock seam, sibling-id exposure, stale-record display — all Low,
  acceptable-with-documentation).
- **Mainnet: NO-GO** until the deferred prerequisites (M5 multisig attestor, V3 detach UI) are done, the
  two V6 dashboard facts (L2 port firewalling, M9 autoDeploy/branch-protection) are confirmed, and
  RA-11-E is checked against the external `vellar-sdk`. The funding-path Highs (RA-1/RA-2) and the
  session/client Highs (RA-11-A/B) are now fixed+tested. Every verdict remains conditional on the
  **unaudited**
  `vellar-sdk` / `passkey-kit` (passkey ceremony, session store, address derivation this repo
  enforces against — and the V1→V2 credential upgrade that drives RA-1 lives in that unread kit).

---

## Closing state — carry this into the SDK audit

Single source of truth for where the dapp repo stands. Every finding, its final status, the remaining
mainnet blockers with owners, and the go/no-go conditions. As of merged `main` through PR #234
(`security/session-client-seam`).

### Status legend

- **closed-by-test** — a defect fix with a passing test whose assertions were read to confirm they
  prove the property (not just the name).
- **closed-by-doc/config** — closed by documentation, a config/lockfile pin, or a product deferral —
  the runtime behavior was NOT changed by a code fix (do not count as code-fixed).
- **deferred** — a real prerequisite intentionally postponed until mainnet is scheduled.
- **open** — not yet fixed (severity noted).

### Every finding

| ID          | Title (short)                                            | Sev  | Final status                                                                                      |
| ----------- | -------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| **C1**      | Sponsor open fee-payer                                   | Crit | closed-by-test (route scope, #229; V2-hardened #231)                                              |
| **H1**      | Unauthenticated 1-XLM/call DoS                           | High | closed-by-test (scope + spend budget, #229/#231)                                                  |
| **H2**      | repoUrl SSRF (host git clone)                            | High | closed-by-test (FIX 6 guard + DNS pin)                                                            |
| **H3**      | Blind SSRF → read primitive via public build log         | High | closed-by-test (private logs + sanitized statusDetail)                                            |
| **M1**      | Session enumeration + revocation                         | Med  | closed-by-test (bearer capability, #232; client #234)                                             |
| **M2**      | deploy-instance no spend cap                             | Med  | closed-by-test (deploy budget line)                                                               |
| **M3**      | Spending-limit tumbling window allows 2×                 | Med  | closed-by-doc (tumbling documented; tests pin 2×)                                                 |
| **M4**      | verified-recipient bricks w/o registry                   | Med  | deferred (product-gated + V3 recovery; no mainnet reg)                                            |
| **M5**      | Attestation registry single-key oracle                   | Med  | **deferred** (boot guard only; multisig attestor TBD)                                             |
| **M6**      | DB fallback fails open + health lies                     | Med  | closed-by-test (readiness) + RA-4 (boot inversion)                                                |
| **M7**      | No reaper for stranded `building` rows                   | Med  | closed-by-test (reaper + dedup + queue cap)                                                       |
| **M8**      | Stale fast-uri override                                  | Med  | closed-by-config (lockfile pin; no test)                                                          |
| **M9**      | Deploy from main, no CI gate                             | Med  | closed-by-config PARTIAL (audit gate + autoDeploy:false; branch-protection is dashboard — see V6) |
| **L1**      | /policies/deploy unverified `deployed` flag              | Low  | closed-by-test (on-chain attach decode, #230)                                                     |
| **L2**      | Downstream 0.0.0.0 bind                                  | Low  | closed-by-config (loopback bind) + **V6 dashboard**                                               |
| **L3**      | No web-app-origin allowlist on pair                      | Low  | closed-by-test (fail-closed allowlist, #230)                                                      |
| **L4**      | Device signing trusts attacker rpcUrl for expiry         | Low  | closed-by-test (trusted RPC anchor + cap, #230)                                                   |
| **L5**      | normalizeOrigin trailing-dot FQDNs                       | Low  | closed-by-test (#230)                                                                             |
| **L6/L6b**  | Cleanup one-tx + unpaginated Horizon / "safe" copy       | Low  | closed-by-test (split + pagination) + copy (#230)                                                 |
| **L7**      | 14 high dep advisories                                   | Low  | closed-by-config (overrides; audit gate)                                                          |
| **I1**      | Markdown injection in bot comment                        | Info | open (accepted — no code exec; escape recommended)                                                |
| **V1**      | /wallet/create derivation gate available                 | —    | closed-by-test (gate implemented, #229)                                                           |
| **V2**      | Relayer is a second unscoped funding source              | —    | closed-by-test (route-level scope, #229/#231)                                                     |
| **V3**      | M4 is NOT permanent fund lock (refuted)                  | —    | invariant pinned (RA-6); detach UI **deferred**                                                   |
| **V4**      | H2+L2 don't compose into spend (refuted)                 | —    | n/a (analysis; reachability tracked under H2/L2)                                                  |
| **V5**      | `network` is a label, not routing input                  | —    | enforced (guards key off config; RA-11-B closed last gap)                                         |
| **V6**      | Two infra facts gated on dashboard                       | —    | **open — OWNER: operator** (see blockers below)                                                   |
| **RA-1**    | Scope gate V1-only; kit signs V2                         | High | closed-by-test (V2/delegate match, #231)                                                          |
| **RA-2**    | Spend-budget INSERT not atomic                           | High | closed-by-test (advisory lock; real-PG concurrency)                                               |
| **RA-3**    | M1 open + stale doc                                      | Med  | closed-by-test (server #232 + client #234); L-1/L-2/L-5 residuals Low, accepted                   |
| **RA-4**    | ALLOW_INMEMORY guard inert (NODE_ENV)                    | Med  | closed-by-test (inverted default, #233)                                                           |
| **RA-5**    | Cleanup pays before cancelling offers                    | Med  | closed-by-test (reorder #231; wizard walk #234)                                                   |
| **RA-6**    | Detach invariant untested at wiring                      | Med  | closed-by-test (wiring assertion); L-3 delegation edge **open** (Low)                             |
| **RA-7**    | isBlockedAddress IPv6 gap                                | Info | open (latent; no reachable path)                                                                  |
| **RA-8**    | Audit hygiene (M3/M4/M5/M8/M9 not code-fixed)            | Info | informational (reflected in this table)                                                           |
| **RA-9**    | Fixture-defect pattern (code-shaped tests)               | Info | closed-by-test (kit-derived fixtures, #231)                                                       |
| **RA-10**   | Network classification from defaulted passphrase (class) | Med  | closed-by-test (explicit STELLAR_NETWORK ×3 svcs, #233)                                           |
| **RA-11-A** | Session client orphaned by M1                            | High | closed-by-test (seam-crossing, #234)                                                              |
| **RA-11-B** | Create budget metered on request body (V5)               | High | closed-by-test (config-keyed; all tryConsume audited)                                             |
| **RA-11-C** | Cleanup wizard drops split chunks                        | Med  | closed-by-test (multi-chunk e2e, #234)                                                            |
| **RA-11-D** | Verification log→statusDetail orphan (#229)              | Low  | closed-by-test (SDK type + UI, #234)                                                              |
| **RA-11-E** | /policies/deploy client is external vellar-sdk           | Low  | **open — OWNER: SDK audit** (unverifiable in-repo)                                                |

### Remaining mainnet blockers (with owners)

1. **M5 — multisig / smart-account attestor** — _OWNER: contracts + backend._ Today only a boot guard
   refuses single-key-on-mainnet (`ALLOW_SINGLE_KEY_ATTESTOR` escape hatch). A real threshold attestor
   must exist before any mainnet attestation registry goes live. Deferred by design.
2. **V3 detach UI** — _OWNER: web._ The standalone-signer detach recovery exists in code + is invariant-
   tested (RA-6), but there is no wired UI to trigger `kit.remove(SignerKey.Policy)`. Needed before
   `verified_only` policies are offered on mainnet.
3. **V6 fact #1 — port exposure (L2 final severity)** — _OWNER: operator (dashboard)._ Confirm the
   platform edge firewalls the internal 4001–4004 listeners. Repo binds loopback + publishes only
   `$PORT`; whether the platform blocks the rest is a dashboard fact, not provable here.
4. **V6 fact #2 — autoDeploy / branch protection (M9 final severity)** — _OWNER: operator (dashboard)._
   Confirm `autoDeploy` is OFF and GitHub branch protection is ON. `render.yaml` sets
   `autoDeploy:false` and CI has the audit gate, but the platform toggle + branch protection are
   dashboard settings.
5. **RA-11-E — external SDK `/policies/deploy` handling** — _OWNER: SDK audit._ The `vellar-sdk` client
   for `/policies/deploy` (which gained 422/503 modes under L1) is not in this repo. Confirm it handles
   `422 no_instance`/`attach_mismatch` and `503 attach_unconfirmed` rather than assuming 2xx. Diff it
   against the Seam Contract section below.
6. **Dependency audit of `vellar-sdk` / `passkey-kit`** — _OWNER: SDK audit._ The load-bearing caveat:
   the passkey ceremony, session store, and the address derivation this repo enforces against all live
   in an unread dependency, as does the V1→V2 credential upgrade that drove RA-1. No mainnet go until
   that kit is itself audited.

### Go / no-go

**NO-GO for mainnet.** The Critical and all funding-path/session Highs found across the audits are
fixed and test-backed (C1, H1–H3, RA-1, RA-2, RA-11-A/B). The gate is held by: the two deferred
prerequisites (M5, V3), the two operator-owned V6 dashboard facts, the external-SDK confirmation
(RA-11-E), and — conditioning every verdict — the unaudited `vellar-sdk`/`passkey-kit`. Testnet posture
is sound today. The residual open items are Low/Info (I1, RA-7, RA-6/L-3, RA-3/L-1/L-2/L-5) and are
acceptable-with-documentation, not go/no-go gates.

---

## Seam contract — the backend HTTP API the external `vellar-sdk` consumes

RA-11 happened because server route contracts changed and nobody checked the consumers. The
`vellar-sdk` is a consumer we **cannot see from this repo**, so the contract is written down HERE. This
is (a) an input to the SDK audit, and (b) the artifact to diff the next time a route changes. Extracted
from the four services' `server.ts` + their zod schemas on `main` through #234; **re-verify against the
code on every route change** and bump the "as of" commit.

### Gateway rules (apply to EVERY route below)

`api-gateway` proxies **1:1, no path rewrite** (`/wallet/*`→wallet, `/policies/*`→policy,
`/verification/*`→verification, `/lifecycle/*`→lifecycle). Reach a route exactly as written. Cross-
cutting behavior a client must satisfy on every call:

- **`415 unsupported_media_type`** — every POST/PUT/PATCH MUST send `Content-Type: application/json`
  (fires before proxying; GET exempt). `{ error, reason }`.
- **`413 payload_too_large`** — body > `MAX_BODY_BYTES` (default 1 MiB). `{ error, reason }`.
- **`429`** — per-IP rate limit (default 120/60s) with `Retry-After`. Distinct from verification's own
  `429 queue_full`. `/health` exempt.
- **CORS** — configured origins only; methods `GET, POST, DELETE`.
- **Envelope**: validation errors carry `{ error, details }` (raw zod issues); others `{ error, message }`
  or bare `{ error }`. **Clients MUST key on the `error` slug, not the message.**

### wallet-service `/wallet/*`

_403 scope/derivation checks fire only when `networkPassphrase` is server-configured; create/deploy 503s
only when `budget`+`budgetNetwork` are set. In dev/no-relayer they cannot fire — an SDK must handle them
when present but not assume they always exist._

| Route                            | Request                                                                    | Success                                                                               | Error modes (slug → when)                                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **POST /wallet/create**          | body `{ keyId, contractId, network:testnet\|mainnet, signedTx }` (all req) | `201 { contractId, sessionId, txHash }`                                               | `400 invalid_body`; `403 contract_id_mismatch` (contractId ≠ derive(keyId) — **slug is `contract_id_mismatch`, NOT `derivation_mismatch`**; client bug, don't retry); `409 wallet_exists` (→ use /connect); `503 create_budget_exceeded` (retry later); `502 <relayer code>` (transient) |
| **POST /wallet/connect**         | body `{ keyId, network }` (both req)                                       | `200 { contractId, sessionId }`                                                       | `400 invalid_body`; **`404 wallet_not_found` — NORMAL "no wallet yet" signal; the reference client returns `undefined`, does NOT throw**                                                                                                                                                 |
| **POST /wallet/submit**          | body `{ signedXdr, network }` (both req)                                   | `200 { hash }`                                                                        | `400 invalid_body`; `403 unscoped_transaction` / `no_wallet_subject` / `unknown_wallet_subject` (C1/H1 scope; client bug); `503 persistence_unavailable` (retry shortly); `502 <relayer code>` (transient)                                                                               |
| **GET /wallet/session**          | **HEADER `Authorization: Bearer <sessionId>`**; no body                    | `200 SessionRecord` `{ id, contractId, network, createdAt, lastActiveAt, expiresAt }` | `401 unauthorized` (missing/malformed/unknown/**expired** — indistinguishable by design). A successful call **slides the 7-day TTL**.                                                                                                                                                    |
| **GET /wallet/sessions**         | **HEADER Bearer**; query `?contractId=&network=`                           | `200 { sessions: SessionRecord[] }`                                                   | `400 invalid_query` (**slug is `invalid_query`, not `invalid_body`**); `401 unauthorized` (no live bearer OR bearer's contractId/network ≠ query — no cross-account enum)                                                                                                                |
| **POST /wallet/sessions/revoke** | **HEADER Bearer**; body `{ targetSessionId }` (req)                        | `204` (empty)                                                                         | `401 unauthorized` (no live bearer; checked before body); `400 invalid_body`; **`404 session_not_found` — target unknown OR different account (cross-account revoke reads as not-found); the client MUST THROW (swallowing 404 as success was the RA-11-A bug)**                         |

### policy-service `/policies/*`

_`deployer` gates /simulate + /deploy-instance (503 `deploy_unavailable`). `verifyAttach` gates the L1
check on /deploy. `budget`+`budgetNetwork` gate the deploy 503._

| Route                                   | Request                                                    | Success                                                                                                            | Error modes                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GET /policies/templates**             | none                                                       | `200` **bare array** `[{ type, title, description, enforcement }]` (**NOT wrapped**)                               | none                                                                                                                                                                                                                                                                                                                     |
| **POST /policies/validate**             | raw `request.body` (unvalidated)                           | `200 { valid, errors: string[] }` — **invalid content still returns 200 with `valid:false`; never 4xx on content** | none                                                                                                                                                                                                                                                                                                                     |
| **POST /policies/generate**             | body `{ definition, network }` (both req)                  | `201 { policy: PolicyRecord }`                                                                                     | `400 invalid_body`; `422 invalid_policy` `{ error, errors }` (**field is `errors` array, not `message`**)                                                                                                                                                                                                                |
| **POST /policies/:id/simulate**         | path `:id`; body `{ wallet: C-address /^C[A-Z2-7]{55}$/ }` | `200 { ok, minResourceFee?, error? }`                                                                              | `503 deploy_unavailable` (first); `400 invalid_body`; `404 policy_not_found`; `422 not_deployable`                                                                                                                                                                                                                       |
| **POST /policies/:id/deploy-instance**  | path `:id`; body `{ wallet: C-address }`                   | `200 { policy, contractId }` (**idempotent**: existing instance returned w/o new spend)                            | `503 deploy_unavailable`; `400 invalid_body`; `404 policy_not_found`; `422 not_deployable`; `503 deploy_budget_exceeded` (retry later); `502 deploy_failed` `{ error, code }` (**field is `code`, not `message`**)                                                                                                       |
| **POST /policies/deploy** ⚠ **RA-11-E** | body `{ policyId, txHash, contractId? }`                   | `200 { policy: PolicyRecord }`                                                                                     | `400 invalid_body`; `404 policy_not_found`; `422 no_instance` (call /deploy-instance first); **`503 attach_unconfirmed` — RETRYABLE, chain unreachable/tx pending, NOT a failure, record NOT stamped**; **`422 attach_mismatch` — a lie, do NOT retry, record NOT stamped**. Network/passphrase from server config (V5). |
| **GET /policies/:id**                   | path `:id`                                                 | `200 { policy: PolicyRecord }`                                                                                     | `404 policy_not_found`                                                                                                                                                                                                                                                                                                   |

`PolicyRecord` = `{ id, createdAt, status: "generated"|"instance_deployed"|"deployed", definition,
policyHash, manifest:{template,enforcement,network}, instance?:{contractId,txHash,wallet,deployedAt},
deployment?:{contractId?,txHash,deployedAt} }`.

### verification-service `/verification/*`

_**H3/#229**: the internal `log` field is stripped by `toPublic` and NEVER returned; public records
carry sanitized `statusDetail?` instead. `sourceArchiveRef` and `lockfileHash` are also stripped._

| Route                                    | Request                                                                                                                                                                       | Success                                                                                   | Error modes                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **POST /verification/submit**            | body `{ contractId(C-addr), sourceType:repo\|upload, toolchainVersion, buildFlags?, lockfileHash? }` + `repoUrl`+`commitHash` **iff repo**, `sourceArchiveRef` **iff upload** | `201 { record: PublicVerificationRecord }` (status `"submitted"`)                         | `400 invalid_body`; `429 queue_full` (M7, ≥ maxActive; retry later; distinct from gateway 429); `409 verification_in_progress` (one active per contract) |
| **GET /verification/:contractId**        | path `:contractId` (C-addr)                                                                                                                                                   | `200 { contractId, records: PublicVerificationRecord[] }` (empty [] if none, **not 404**) | `400 invalid_contract_id` `{ error }` (**no `details`**)                                                                                                 |
| **GET /verification/:contractId/status** | path `:contractId` (C-addr)                                                                                                                                                   | `200 { contractId, status, recordId?, updatedAt? }`; unknown → `status:"unverified"`      | `400 invalid_contract_id`                                                                                                                                |

`PublicVerificationRecord` = `{ id, contractId, sourceType, repoUrl?, commitHash?, toolchainVersion,
buildFlags?, outputHash?, deployedHash?, status, createdAt, updatedAt, statusDetail? }`. `status` ∈
`unverified|submitted|building|verified|failed|dead_letter`.

### lifecycle-service `/lifecycle/*`

_No auth header on any route. `CleanupStep` = `{ title, description, xdr, hash }`. `CleanupPlan` =
`{ accountId, destination, blockers:[{type,description,actionRequired}], estimatedTransactions, mergeReady }`._

| Route                       | Request                           | Success                                                                        | Error modes                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **POST /lifecycle/inspect** | body `{ accountId }`              | `200 { account: HorizonAccount }`                                              | `400 invalid_body`; `400 not_classic_account` `{ error, message }` (not a G-address); `404 account_not_found`                                                                                                                |
| **POST /lifecycle/plan**    | body `{ accountId, destination }` | `200 { plan: CleanupPlan }`                                                    | `400 invalid_body`; `400 not_classic_account` `{ error, message }`; `400 invalid_destination` `{ error, message }` (bad G-addr OR == accountId); `404 account_not_found`                                                     |
| **POST /lifecycle/execute** | body `{ accountId, destination }` | `200 { steps: CleanupStep[], plan }` (may be MULTIPLE steps — split; walk all) | `400 invalid_body`; `400 not_classic_account` **bare `{ error }` (no message)**; `400 invalid_destination` **bare `{ error }`**; `404 account_not_found`                                                                     |
| **POST /lifecycle/merge**   | body `{ accountId, destination }` | `200 { step: CleanupStep }`                                                    | `400 invalid_body`; `400 not_classic_account` **bare `{ error }`**; `400 invalid_destination` **bare `{ error }`**; `404 account_not_found`; **`409 not_merge_ready` `{ error, plan }` — body carries the full CleanupPlan** |

### SDK-diff gotchas (the things most likely to mismatch)

1. **`contract_id_mismatch`**, not `derivation_mismatch` — the create-derivation-gate slug. Verified at
   `derivation.ts:47`. Single most likely SDK error-handling mismatch.
2. **Conditional errors**: 403 scope/derivation + create/deploy 503s only exist when server config is
   present. Handle-when-present, don't assume-always.
3. **Inconsistent envelopes**: `/policies/templates` returns a **bare array**; everything else wraps in
   `{ policy }`. `/policies/validate` **never 4xx's on content** (200 `{valid:false}`).
4. **Same slug, different envelope**: `/plan` + `/inspect` give `{error,message}` for classic/dest 400s,
   but `/execute` + `/merge` give **bare `{error}`** — an SDK reading `message` gets `undefined` there.
5. **`invalid_query`** (not `invalid_body`) for `GET /wallet/sessions`; **`invalid_contract_id`** (no
   `details`) for verification path params.
6. **404 semantics differ**: `/wallet/connect` 404 = normal "no wallet" → return `undefined`;
   `/wallet/sessions/revoke` 404 → **MUST throw** (the RA-11-A silent-success bug).
7. **`log` is gone** from all verification responses; `statusDetail` is the only failure-detail field.
8. **Retryable vs terminal on `/policies/deploy`**: `503 attach_unconfirmed` = retry (pending);
   `422 attach_mismatch` = terminal (a lie). Different handling, same route.
9. **Session bearer** travels only in the `Authorization` header / revoke body — never a URL. `401
unauthorized` is intentionally identical for missing/unknown/expired/wrong-account.
10. **Gateway 415** — every mutation must send `Content-Type: application/json` or it never reaches the
    service (415 before the handler).
