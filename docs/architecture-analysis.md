# Vellar Wallet — Architecture Analysis

> Read-only architectural analysis of the Vellar Stellar smart-wallet monorepo.
> No files were modified to produce it. Every claim carries a `file:line` citation;
> inferences are marked `(inferred)`. Produced by 12 parallel subsystem readers +
> 2 cross-cutting sweeps (auth end-to-end; data/secret handling), reconciled by a
> completeness critic that walked the repo tree and spot-checked load-bearing claims.

**The one-line summary:** Vellar's backend has _no application-layer authentication or
authorization on any route_ — this is deliberate. Passkeys sign client-side, the backend
is a stateless relayer, and the real authorization lives on-chain (`__check_auth` + policy
contracts) and in the extension's per-origin grant model. The exposure is concentrated in
the side effects that are _not_ gated on-chain (sponsor-fund spend, session ops) and in the
fact that the gateway trust boundary is enforced by network topology, not by code.

---

## 1. Stack

A pnpm + Turborepo TypeScript monorepo (Node ≥ 22) fronting a Rust/Soroban contract
workspace. The backend runs TypeScript directly via `tsx` — no build step in production.

**Languages & runtimes**

- TypeScript 5.9, ESM throughout; pnpm `11.9.0`, Turborepo `2.5.4` — `package.json:4-21`, `pnpm-workspace.yaml:1-4`
- Node ≥ 22 in `engines`, but `render.yaml` pins `NODE_VERSION=20` for the deployed backend — a direct conflict nothing enforces — `package.json:5-7`, `render.yaml:26-28`
- Rust 1.94.0, target `wasm32v1-none`, `soroban-sdk 27.0.0` — `contracts/rust-toolchain.toml:2-3`, `contracts/Cargo.toml:28`

**Frameworks & libraries**

- Backend: Fastify 5 on every service; zod 4 for input validation; Drizzle ORM 0.45 + `pg` — `services/*/package.json`, `services/wallet-service/src/server.ts:20-42`
- Web: Next.js 16 + React 19 (App Router, client-only), TanStack Query, Zustand, react-hook-form + zod, Tailwind 4 — `apps/web/package.json:17-45`
- Extension: WXT 0.20 (Manifest V3) + React 19 popup — `apps/extension/package.json:23-33`, `wxt.config.ts`
- Wallet/passkey: third-party `passkey-kit ^0.14.0` does the real WebAuthn ceremonies and Soroban auth-entry signing, in-browser — `apps/web/lib/connector-factory.ts:52-61`, `apps/extension/lib/tx-signer.ts:51-61`

**Databases & external services**

- Postgres 16 (per-service Drizzle migrations); documented in-memory fallback when `DATABASE_URL` is unset. Redis 7 is provisioned in local docker-compose but no runtime code depends on it, and no deploy manifest provisions it — `infra/docker/docker-compose.yml:6-32`, `README.md:37-39`
- OpenZeppelin Relayer (testnet) for fee-sponsored submission; Soroban RPC + Horizon (testnet defaults) — `services/wallet-service/src/config.ts:18-27`, `services/lifecycle-service/src/horizon.ts:44`
- Deterministic build image (`rust:1.94.0` + `stellar-cli 26.1.0`) run by the worker for byte-for-byte contract verification — `infra/docker/verification-builder.Dockerfile:21,26`

**On-chain components**

- Three deployed Soroban contracts: two spending-limit policy templates, a verified-recipient policy, and an attestation registry — `contracts/Cargo.toml:13-18`
- The smart account itself is external: the deployed wallet is `kalepail/passkey-kit`'s audited wasm (pinned by git commit `50981cc`); this repo's `contracts/smart-account/` is an empty reserved directory, so `__check_auth` / secp256r1 WebAuthn verification is **not in-repo** — `contracts/Cargo.toml:9-10,40`

**Deploy topology (important)**

Three deploy manifests coexist. `vercel.json` deploys only `apps/web`; `railway.json` and
`render.yaml` both deploy the combined single-process `@vellar/all-in-one` backend
(gateway + wallet + lifecycle + policy + verification in one Node process).
**worker-service and permission-service are deployed nowhere.** With no worker in the hosted
topology, contract-verification jobs sit in `status='submitted'` forever, and there is no
on-chain attestor. — `services/all-in-one/package.json:12-18`, `render.yaml`, `railway.json`

---

## 2. Component map

**Apps**

| Module                       | Owns                                                                                                                                                                                                                                                          | Depends on                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web` (Next.js 16)      | Client-only frontend. Zero server surface — no `app/api` handlers, no middleware, no server actions. Passkey ceremonies + signing in-browser; POSTs signed XDR to the gateway; reads balances/tx-status directly from RPC/Horizon.                            | passkey-kit, vellar-sdk (npm), @vellar/{provider-sdk, verification-sdk, ui, types}, api-gateway |
| `apps/extension` (WXT / MV3) | Companion signing surface. Injects `window.vela` into every page via a MAIN-world content script; relays zod-validated envelopes through an isolated bridge to a background worker; enforces per-origin grants + explicit popup approval for every signature. | passkey-kit, @vellar/provider-sdk, device WebCrypto key, Soroban RPC                            |
| `apps/docs` (markdown)       | 8 git-tracked docs (API reference, security model, core flows). Documentation-only, not a workspace member — but it _is_ the only product spec that ships in git history.                                                                                     | —                                                                                               |

**Shared packages**

| Package                                       | Status & role                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vellar/service-kit`                         | **Shared backend bootstrap** — health route, structured event log, DB-connect wrapper with credential redaction, listen/shutdown lifecycle, Prometheus metrics. Provides **no** auth, CORS, rate-limit, CSRF, or body validation; all opt-in helpers, default bind `0.0.0.0`. `packages/service-kit/src/index.ts` |
| `@vellar/provider-sdk`                        | The real dApp↔extension wire protocol: zod schemas for 6 methods, page-side provider, per-origin permission model + `normalizeOrigin`. Shared by extension and web.                                                                                                                                               |
| `@vellar/passkey`                             | WebAuthn _support detection_ + error normalization **only** — no credential create/assert. The real ceremonies live in `passkey-kit`. `packages/passkey/src/support.ts`                                                                                                                                           |
| `@vellar/verification-sdk`                    | Fetch client for the verification API + trust-signal label mapping.                                                                                                                                                                                                                                               |
| `@vellar/types`                               | Dependency-free domain model (session, policy schema, verification records, cleanup plans).                                                                                                                                                                                                                       |
| `@vellar/ui`                                  | One component: `TrustBadge`.                                                                                                                                                                                                                                                                                      |
| `@vellar/policy-sdk`, `@vellar/lifecycle-sdk` | **Empty stubs** (`export {}`). Policy-client work was deliberately shipped inside the external `vellar-sdk` npm package instead. `packages/policy-sdk/src/index.ts:1-3`, `BUILD-PLAN.md:175`                                                                                                                      |

> Note: the formerly-planned `packages/wallet-sdk` was deleted; web + extension now consume
> the externally published `vellar-sdk ^0.4.0` (a separate repo, not auditable here). The root
> CLAUDE.md repo map and technical-doc.md still list `wallet-sdk` — they are stale on this
> point. `docs/decisions.md:214-224`

**Backend services**

| Service                | Owns                                                                                                                                                                                                | Port           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `api-gateway`          | The single public entry point. helmet, per-IP rate limit, CORS allowlist, body-size cap, JSON-content-type CSRF check, then a transparent reverse proxy of 4 path prefixes. **No auth logic.**      | 4000           |
| `wallet-service`       | keyId→contractId mapping, session records, audit log, relays client-signed XDR. Holds the fee-sponsor key.                                                                                          | 4001           |
| `lifecycle-service`    | Stateless classic-account cleanup/merge _planner_; builds unsigned XDR, never signs or submits.                                                                                                     | 4002           |
| `policy-service`       | Validate/generate policy definitions; sponsor-funded on-chain policy-instance deploys.                                                                                                              | 4003           |
| `verification-service` | Accepts contract-source submissions, persists them; the DB row _is_ the job queue.                                                                                                                  | 4004           |
| `worker-service`       | Polls the shared DB, rebuilds contracts in a sandboxed Docker container, compares wasm hashes, mirrors verdicts on-chain. Holds the attestor key — deliberately isolated from sponsor-key services. | 4005 (metrics) |
| `permission-service`   | **Empty stub** (`export {}`). The dApp-permission store it was named for lives entirely in the extension.                                                                                           | —              |
| `all-in-one`           | Not a server — a process shim that `await import`s five services into one process for demo hosting. Excludes the worker (untrusted builds must not share a process with sponsor keys).              | $PORT          |

**Contracts (Soroban / Rust)**

- **spending-limit / token-spending-limit** — cumulative rolling-window allowance over SEP-41 transfers; the token-scoped variant binds the budget to one token. Evaluated as a required co-signer inside the wallet's `__check_auth`. `contracts/policy-templates/spending-limit/src/lib.rs:205-305`
- **verified-recipient** — rejects any authorization touching a contract without a live attestation; makes a cross-contract `is_verified` call per context. `contracts/policy-templates/verified-recipient/src/lib.rs:158-211`
- **attestation-registry** — a single rotatable attestor writes time-bounded `(contract, wasm_hash, expires_ledger)` records; config is constructor-immutable, no upgrade/setter functions. `contracts/attestation-registry/src/lib.rs:124-180`

---

## 3. Data flow

Every mutating flow follows the same shape: the browser or extension does the signing, the
backend relays already-signed XDR, and Stellar's `__check_auth` is the real gate. Validation
at the services is zod shape-checking only.

**Backend HTTP entry points** (every route is reachable unauthenticated — see §5)

| Method | Route                                               | Enters → validation → touches → leaves                                                                                                                                                                                            |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/wallet/create`                                    | {keyId, contractId, network, signedTx} (zod). Submits signedTx _before_ persisting → relayer or sponsor-RPC → writes wallets + session + audit rows. `wallet-service/src/server.ts:76`                                            |
| POST   | `/wallet/connect`                                   | {keyId, network}. Looks up wallet, mints a session UUID. **No WebAuthn assertion verified** — possession of a keyId string is sufficient. `wallet-service/src/server.ts:109`                                                      |
| POST   | `/wallet/submit`                                    | {signedXdr, network}. Submits arbitrary XDR; the sponsor path rebuilds address-auth txs around the server sponsor account at a hardcoded 10,000,000-stroop fee bid. `wallet-service/src/server.ts:128`, `sponsor.ts:26-60`        |
| GET    | `/wallet/session/:id`                               | Returns a session record by UUID. `wallet-service/src/server.ts:154`                                                                                                                                                              |
| GET    | `/wallet/sessions`                                  | ?contractId&network → lists **all** sessions for any supplied contractId. No ownership check. `wallet-service/src/server.ts:163`                                                                                                  |
| DELETE | `/wallet/session/:id`                               | Revokes any session by id. Privileged, unauthenticated. `wallet-service/src/server.ts:172`                                                                                                                                        |
| POST   | `/policies/validate` · `/generate`                  | Validate against a fixed template registry; generate a content-hashed policy record. `policy-service/src/server.ts:93-119`                                                                                                        |
| POST   | `/policies/:id/simulate`                            | Dry-run the instance deploy (build + simulate, no submit). `policy-service/src/server.ts:124`                                                                                                                                     |
| POST   | `/policies/:id/deploy-instance`                     | Wallet address (C-address regex) → **sponsor-funded on-chain deploy** bound to that address, signed by `SPONSOR_SECRET_KEY`. No proof the caller owns the wallet. `policy-service/src/server.ts:156`, `deploy.ts:102`             |
| POST   | `/policies/deploy`                                  | Marks any policyId "deployed" with a **client-supplied txHash** — never verified on-chain. `policy-service/src/server.ts:206`                                                                                                     |
| POST   | `/lifecycle/inspect` · `plan` · `execute` · `merge` | Reads any classic account from Horizon; builds **unsigned** cleanup/merge XDR for any account→destination. Merge refuses if blockers remain. Safe only because the user must still sign. `lifecycle-service/src/server.ts:40-133` |
| POST   | `/verification/submit`                              | {contractId, repoUrl/commit \| archiveRef, toolchain}. `repoUrl` is `z.string().url()` with no host allowlist → SSRF-shaped input flows to the build worker. Persists a job row. `verification-service/src/server.ts:149`, `:95`  |
| GET    | `/verification/:contractId` · `/status`             | Public read — the trust-badge lookup for web + extension. `verification-service/src/server.ts:193-222`                                                                                                                            |
| GET    | `/health`, `/metrics`                               | On every service, unauthenticated. `/metrics` is Prometheus text. `packages/service-kit/src/index.ts:15-17`, `metrics.ts:131`                                                                                                     |

**Non-HTTP entry points**

- **Worker build-poll loop** — self-rescheduling `setTimeout` (250ms busy / 5s idle). Claims `status='submitted'` rows via `FOR UPDATE SKIP LOCKED`; Postgres is the queue (no Redis/BullMQ). `worker-service/src/loop.ts:75-106`, `pg-job-store.ts:19-30`
- **Attestation upgrade sweep** — `setInterval`, 10-min default, only when attestor key + registry id are set; revokes attestations for upgraded/vanished contracts. `worker-service/src/index.ts:105-107`
- **Extension provider methods** (message handlers, not HTTP): `connect · sign_transaction · get_address · disconnect · pair · pair_status`, routed page→content-script→background. `apps/extension/lib/router.ts:37-99`
- **Contract public functions** — registry `upsert/revoke/set_attestor` (attestor-auth) + unauthenticated reads; each policy's `install/uninstall/policy__/config`. `contracts/*/src/lib.rs`
- **CI PR-guard workflows** — two `pull_request_target` jobs auto-close non-maintainer PRs (to main, or touching files outside `contrib/`). No cron schedules exist anywhere. `.github/workflows/close-prs-*.yml`

**The two signing flows, end to end**

- **web · send / policy / pairing:** Client builds tx → passkey-kit signs auth entries in-browser (WebAuthn) → explicit review dialog → POST signed XDR to `/wallet/submit` → server relays → RPC polling tracks confirmation. The server never holds the passkey.
- **extension · dApp signing:** Page → `window.postMessage` → isolated bridge → background derives **trusted origin from the sender** (never page data) → router checks a per-origin grant → popup approval (every tx) → device Ed25519 key signs → signed XDR returned. No silent signing.

---

## 4. Trust boundaries

Two boundaries are correctly enforced (the extension origin model and the on-chain
`__check_auth`). One is enforced only by network topology, not by code — and that gap is
where the exposure concentrates.

```
Browser/dApp  ──[CORS·ratelimit·CSRF]──►  api-gateway  ──[NO AUTH·plain HTTP]──►  downstream services  ──[sponsor/relayer key]──►  Stellar chain
(untrusted)      (authenticates origin,      (the one         (bind 0.0.0.0, trust           (signed XDR;          (__check_auth +
                  not user)                   server-side       anything on the port)          value auth is          policy contracts —
                                              boundary)                                         here)                  the real gate)
```

**CRITICAL GAP — gateway boundary is topology-only.** Every downstream service binds
`0.0.0.0` with no shared secret, signed header, or mTLS. If any downstream port (4001-4004)
is exposed, it bypasses _all_ gateway controls — CORS, rate-limit, body cap, CSRF. In the
`all-in-one` deployment they are co-located on localhost, but each still listens on its own
`0.0.0.0` port; isolation depends entirely on the platform publishing only `$PORT`.
`api-gateway/src/server.ts:122-152`, `service-kit/src/index.ts:88`

**Boundaries ranked by how well they hold**

| Strength      | Boundary                        | Enforcement                                                                                                                                                                                                          |
| ------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STRONG        | Page → extension background     | Origin derived from the browser-supplied content-script sender, never page data; every message zod-validated; every signature needs popup approval. `background.ts:41-44`, `permissions.ts:38-49`                    |
| STRONG        | Service → Stellar chain         | On-chain `__check_auth` validates passkey signatures; wrongly-signed XDR simply fails. Delegated entirely to the chain. `wallet-service/src/server.ts:128-152`                                                       |
| STRONG        | Untrusted source → build worker | Builds run `--network=none`, `--read-only`, `cap-drop=ALL`, non-root, resource-capped; worker kept out of the sponsor-key process by design. `worker-service/src/executor.ts:188-222`                                |
| ORIGIN-ONLY   | Internet → api-gateway          | CORS allowlist + per-IP rate limit + 1 MiB body cap + JSON-content-type CSRF check. Authenticates origin, not identity; rate-limit is in-memory per-process with no `trustProxy`. `api-gateway/src/server.ts:70-117` |
| TOPOLOGY-ONLY | Gateway → downstream services   | No authentication of any kind. Reachability is the only control. `api-gateway/src/server.ts:122-152`                                                                                                                 |
| UNENFORCED    | Caller → sponsor-funded spend   | `/policies/:id/deploy-instance` and the `/wallet/submit` sponsor path let any unauthenticated caller spend sponsor funds for an arbitrary wallet/contract. `policy-service/src/server.ts:156`, `sponsor.ts:26-60`    |

---

## 5. AuthN / AuthZ model

The backend has **no application-layer authentication or authorization on any route.** This
was grep-verified: across all services, the only match for `authorization|bearer|jwt|x-api-key`
is a Soroban XDR type name (`SorobanAuthorizationEntry`).

**The model.** Identity is established client-side by the WebAuthn/passkey ceremony (via
`passkey-kit`), which produces signed Stellar XDR. The backend never verifies a WebAuthn
attestation or assertion, issues no token, and checks no caller identity — it is a stateless
relayer. Security rests on (a) Stellar validating the passkey-signed on-chain auth entry, and
(b) the extension's per-origin grant model. `docs/decisions.md:441`, `wallet-service/src/server.ts:16-18`

**What passes for a session.** A "session" is an opaque `crypto.randomUUID()` row
(`wallet_sessions`) returned to the client at create/connect. Since RA-3/M1 it is a **bearer
capability, scoped to the session routes only**: possession authorizes listing / reading /
revoking the sessions of the account that session is bound to, and **nothing else** — it grants
no signing or funding authority (those remain on-chain via `__check_auth`), and no other route
reads it. It **expires on a 7-day sliding window** (matching the device signer's 7-day expiry;
`lastActiveAt` + `expiresAt` slide forward only on an authorized use), and it travels only in the
`Authorization: Bearer` header / request body — never a URL — so the credential never lands in a
request log. `wallet-service/src/server.ts` (session routes), `db/schema.ts` (`expires_at`)

**Where authorization is real:**

- **wallet-service · session capability** — the session id is a bearer capability for the session
  routes (list / read / revoke), bound to `contractId + network`, 7-day sliding expiry (RA-3/M1).
  It is deliberately narrow: it authorizes ONLY those routes and is not honored anywhere else, so it
  does not become the app-layer auth the design otherwise omits. `wallet-service/src/server.ts`
- **extension · per-origin grants** — `connect` / `view_address` / `sign` capabilities, keyed to `origin + network`. A `sign` grant only lets a dApp _ask_; every individual transaction still requires fresh popup approval. Pairing a different address wipes all grants. `router.ts:87-94`, `state.ts:56-61`
- **on-chain · policy contracts** — the device signer is a **7-day expiring Ed25519 co-signer**; policy contracts enforce spending limits and recipient allowlists inside `__check_auth`; contexts targeting the wallet's own admin surface are always rejected. `connector-factory.ts:87-106`, `spending-limit/src/lib.rs:235-239`

**Unauthenticated privileged actions.** Because value transfer is gated on-chain, most
unauthenticated routes leak or waste rather than steal. These are the exceptions where the
side effect is real:

| Impact     | Action                               | Consequence                                                                                                                                        |
| ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| FUNDS      | `POST /policies/:id/deploy-instance` | Any caller makes the sponsor pay to deploy a policy instance bound to an arbitrary wallet — no ownership proof. `policy-service/src/server.ts:156` |
| FUNDS      | `POST /wallet/submit` (sponsor path) | Any caller submits address-auth XDR and the server pays fees (10M-stroop bid) for arbitrary contracts. `sponsor.ts:26-60`                          |
| INTEGRITY  | `DELETE /wallet/session/:id`         | Anyone with a session id revokes it — no ownership check. `wallet-service/src/server.ts:172`                                                       |
| DISCLOSURE | `GET /wallet/sessions`               | Lists all sessions for any (public) contractId supplied in the query. `wallet-service/src/server.ts:163`                                           |
| INTEGRITY  | `POST /policies/deploy`              | Marks any policy "deployed" with an unverified client-supplied txHash. `policy-service/src/server.ts:206`                                          |
| IDENTITY   | `POST /wallet/connect`               | keyId lookup alone yields a session — no proof-of-possession of the credential. `wallet-service/src/server.ts:109`                                 |

**CORS & CSRF posture.** Applied **only at the gateway**: CORS restricted to configured
origins (`GET/POST/DELETE`); CSRF mitigated by requiring `application/json` on mutations (415
otherwise), valid because the API is cookieless. Downstream services register no CORS and
re-check nothing — they rely on being unreachable. The client attaches no cookie,
Authorization header, or `credentials` option, so the cookieless-CSRF rationale is internally
consistent. `api-gateway/src/server.ts:81-116`, `http-backend.ts:56-62`

---

## 6. Data classification

The design deliberately avoids server custody of user keys — passkeys sign client-side and
the backend only ever receives signed XDR. But the backend holds three classes of operational
Stellar secrets, and real testnet secret values sit in the working tree (all gitignored, none
in git history).

**Secrets & keys**

| Secret                | Held by                        | Storage / exposure                                                                                                                                                                                                                       |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPONSOR_SECRET_KEY`  | wallet-service, policy-service | Stellar secret funding fee-sponsorship + policy deploys. Env-injected; a real testnet value is in the local gitignored `.env`. Compromise = drain of the sponsor account. `sponsor.ts:43`, `deploy.ts:102`                               |
| `RELAYER_API_KEY`     | wallet-service                 | OpenZeppelin relayer credential. Transmitted server-side to the relayer over HTTPS; never shipped to the browser by design. `config.ts:23`, `relayer-passkey.ts:14-17`                                                                   |
| `ATTESTOR_SECRET_KEY` | worker-service _only_          | On-chain attestation signer, deliberately never co-located with sponsor keys. **Absent from `.env.example` and every deploy manifest** — its provisioning is undetermined. `worker-service/src/config.ts:42`, `registry-submitter.ts:39` |
| Device Ed25519 key    | extension (client)             | **Non-extractable** WebCrypto key in IndexedDB — signs but can never be exported, even by extension code. Only the public key hex crosses to the web app. Strong handling. `device-key.ts:23-27,66`                                      |
| Passkey private key   | platform authenticator         | Never leaves the device; the server never sees it. No server key custody by design. `docs/decisions.md:441`                                                                                                                              |
| `VERCEL_OIDC_TOKEN`   | working tree                   | Live short-lived JWTs in `.env.local` / `apps/web/.env.local`. Gitignored, never in history; worth rotating if the machine is shared. `apps/web/.env.local:2`                                                                            |

**Persisted data — pseudonymous, no PII**

- **No emails, handles, or PII** in any migration. The `username` field at onboarding is optional and never persisted server-side. `services/*/drizzle/0000_init.sql`
- `keyId` (base64 WebAuthn credential id) stored plaintext as the wallet primary key — a stable user-linkable identifier, not cryptographically secret, but the sole authentication factor for `/wallet/connect`. `wallet-service/src/db/schema.ts:10`
- `activity_logs.data` jsonb holds only contractId / network / txHash / sessionId — pseudonymous on-chain identifiers, no key material. `wallet-service/src/server.ts:104`
- `verification_records` stores developer-supplied build metadata (repoUrl, commit, toolchain, flags) plus the worker-written build log — which is returned **publicly** and can leak build-host paths/environment detail. `verification-service/src/server.ts:229-232`

**Logging.** No secret or request-body logging found. Services use Fastify/pino defaults
(method/url/status only) — request bodies and headers are not logged, and no `pino redact` is
configured because none is needed. The one redaction helper, `redactDbUrl`, masks Postgres
credentials before the degrade warning. `service-kit/src/index.ts:66-76`. Client-side config
in `NEXT_PUBLIC_*` (RPC URL, wasm hash, API URL) is intentionally public; no server secret is
exposed through it. Unauthenticated `/metrics` on every service exposes operational telemetry,
not PII.

---

## 7. Assumptions the code makes

**Implied, not enforced** (where surprises live):

- **Downstream ports are private.** Services bind `0.0.0.0` with no service-to-service auth; if a port is exposed, every gateway control is bypassed. `service-kit/src/index.ts:88`
- **Possession of a keyId equals wallet ownership.** `/wallet/connect` mints a session from a keyId string with no WebAuthn assertion verified. And `/wallet/create` never checks that `signedTx` actually deploys `contractId` or that `keyId` controls it — a malicious client could map its keyId to someone else's contract. `wallet-service/src/server.ts:81-125`
- **Callers own the wallet they name.** Sponsor-funded deploys and session listing/revocation trust a caller-supplied address/id with no ownership binding. `policy-service/src/server.ts:156`
- **The `network` field matches the configured RPC.** A request claiming `network:'mainnet'` is still submitted through the testnet-defaulted submitter; `network` is only a storage/metrics label. `wallet-service/src/config.ts:31-32`
- **Sponsor/relayer/attestor keys are testnet.** Code comments assume it; nothing enforces it. On mainnet the unauthenticated sponsor endpoints become real financial exposure. `wallet-service/src/config.ts:11-13`
- **`repoUrl` is safe for the worker to fetch.** Any syntactically valid URL passes — including internal/SSRF-shaped targets; the worker `git clone`s it on the host. `verification-service/src/server.ts:95`

**Relied upon (mostly benign):**

- **In-memory fallback is dev-only.** With no `DATABASE_URL`, a misconfigured production would run statelessly (data lost on restart) behind only a warning — health checks still pass. `wallet-service/src/index.ts:57-61`
- **MV3 sender origin is unforgeable.** The entire extension origin-security model rests on this browser guarantee — a correct assumption given the isolated-world model. `background.ts:41`
- **A stranded `building` row is re-claimable.** A comment promises reclaim-after-timeout, but **no reaper exists** — a worker crash mid-build strands the record in `building` forever. `worker-service/src/loop.ts:38`, `pg-job-store.ts:22`
- **Horizon responses match asserted shapes.** lifecycle-service uses `as` casts with no runtime validation; ≤200 offers assumed (no pagination), and >100 cleanup ops would produce an invalid single transaction. `lifecycle-service/src/horizon.ts:47-56`, `builder.ts:41-42`
- **The spending window is fixed, not sliding.** Reset-on-elapse means up to 2× the daily limit can move across a window boundary in under `window_seconds`. `spending-limit/src/lib.rs:270-284`
- **One wasm hash fits all policy templates.** policy-service wires a single `SPENDING_POLICY_WASM_HASH` for every template; a `verified_only` deploy would use the spending wasm — it survives only because the constructor reverts in simulation. `policy-service/src/index.ts:12-21`

---

## 8. Gaps & open questions

Things not determinable from the code alone. These change the risk assessment materially.

- **Q1 — Which deploy target is actually live (Render, Railway, or neither)?** The entire gateway-as-boundary model depends on ports 4001-4004 being unreachable, which no file in the repo can prove. Does the live platform expose only `$PORT`?
- **Q2 — Is worker-service deployed anywhere?** No deploy config references it or provisions `ATTESTOR_SECRET_KEY`. Without it, hosted contract verification can never complete and there is no on-chain attestor. Is it run out-of-band, and in which mode (Docker sandbox vs. stub executor)?
- **Q3 — Are the sponsor / relayer / attestor keys strictly testnet in the live environment?** Nothing in code enforces it, and the unauthenticated sponsor-funded endpoints become real financial exposure on mainnet.
- **Q4 — Is any server-side auth planned before V1** (session validation, WebAuthn assertion verification, service-to-service auth), or is "the on-chain signature is the authorization" the intended end state? There is zero scaffolding for it today, and `permission-service` is an empty stub.
- **Q5 — Where does the authoritative product spec live going forward?** `technical-doc.md`, `idea.md`, `BUILD-PLAN.md`, `CLAUDE.md`, and `docs/decisions.md` are all gitignored — they exist only in the working tree. A fresh clone has none of them. Is there a backup elsewhere?
- **Q6 — The `vellar-sdk` npm package and the `vellar-facilitator` service live outside this repo.** They carry the actual passkey ceremony, session store, and x402 payment/authorization model — none of which is auditable here. Do their repos exist, and who controls publishing? (The x402 surface that dominates the web app's landing copy has no implementation in this repo; it presumably lives in that SDK.)
- **Q7 — Should `/metrics` be network-restricted or auth-gated in production?** It is unauthenticated on every service, and in `all-in-one` the gateway's public `/metrics` exposes the combined series of every co-located service.

---

_Method: 12 parallel subsystem readers + 2 cross-cutting sweeps (auth end-to-end; data/secret
handling), reconciled by a completeness critic that walked the repo tree for coverage holes
and spot-checked load-bearing security claims against the cited files. Read-only — no files
were modified._

---

## 9. Security Hardening & Integration Testing Verification

- **Account Merge Integration Testing**: Integration test suite in `services/lifecycle-service/src/account-merge.integration.test.ts` exercises full end-to-end account merge across `wallet-service`, `lifecycle-service`, and `policy-service`. Validates state consistency across database tables and verifies mid-process merge failure handling when blockers remain.
- **Passkey Rate Limiting**: `POST /wallet/connect` in `wallet-service` is rate-limited per IP and `keyId`, returning `429` with `retry-after` header and tracking rate-limited auth attempts via `vela_passkey_auth_rate_limited_total` domain metric.
- **CORS Origin Restriction**: `api-gateway` restricts allowed CORS origins to explicit web and extension domains (`http://localhost:3000`, `https://app.vellar.wallet`, `chrome-extension://vellar-wallet-extension`), with strict origin verification rejecting foreign/unauthorized origins.
- **Contracts Build Pipeline Hardening**: All Rust dependencies in `contracts/Cargo.toml` (`soroban-sdk`, `ed25519-dalek`, `smart-wallet-interface`) are pinned to exact versions and commit hashes, with CI verification enforcing supply-chain security.

