# Issue 339 — Pre-Deploy Smoke Test Script for the Services Workspace

Sandboxed reference implementation (per `contrib/README.md` — this cannot add
a script to the real `services/` workspace or root `package.json` directly;
see the PR description) of a CI-friendly smoke test that hits every service's
`/health` endpoint and runs a basic wallet-creation e2e check, exiting
non-zero on any failure.

## What it checks, and why those checks

Grounded in the real workspace layout (`services/*`, root `.env.example`,
`packages/service-kit/src/index.ts`):

1. **Health checks for every service that has one.** All real services except
   `permission-service` (currently an empty stub — `export {};`, nothing to
   check) expose `GET /health` via the shared `registerHealth()` helper in
   `packages/service-kit/src/index.ts`, which returns
   `{ status: "ok", service: <name> }` (200) or
   `{ status: "unavailable", service: <name> }` (503) when a DB-aware
   readiness probe fails. Default ports, from root `.env.example`:

   | Service | Port env var | Default port |
   | --- | --- | --- |
   | api-gateway | `PORT` | 4000 |
   | wallet-service | `WALLET_SERVICE_PORT` | 4001 |
   | lifecycle-service | `LIFECYCLE_SERVICE_PORT` | 4002 |
   | policy-service | `POLICY_SERVICE_PORT` | 4003 |
   | verification-service | `VERIFICATION_SERVICE_PORT` | 4004 |
   | worker-service | `WORKER_METRICS_PORT` | 4005 (metrics-only Fastify app, not the main worker loop) |

   `permission-service` is intentionally excluded from the default target
   list — it has no server, no port, no `/health` route today. The script
   still accepts it via `SMOKE_TARGETS` if/when it grows one (see below), so
   this doesn't silently stay stale.

2. **A basic e2e check: wallet creation.** Mirrors the real contract
   confirmed in `services/wallet-service/src/server.test.ts`:
   `POST /wallet/create` with `{ keyId, contractId, network, signedTx }`
   returns `201` with `{ contractId, txHash, sessionId }`. The smoke script
   posts a synthetic payload and asserts a `201` with those three fields
   present — this is a shape/liveness check (is the route wired end to end
   and responding correctly), not a real on-chain deploy.

3. **CI-friendly exit code.** Exits `0` only if every configured target
   passes; exits `1` (non-zero) the moment anything fails or times out, after
   printing a summary of every check (pass/fail per target), so a CI log
   shows the full picture in one run rather than stopping at the first
   failure.

## Files

- `route.mjs` — the smoke-test engine (`checkHealth`, `checkWalletCreate`,
  `runSmokeTest`) plus a CLI entrypoint that reads `SMOKE_TARGETS`/`SMOKE_BASE_URL`
  from the environment, runs all checks, prints a summary, and calls
  `process.exit(1)` on any failure. Uses `fetch` (Node 22+, matching this
  repo's `engines.node: ">=22"` in the root `package.json`) against
  **mocked** service responses in this sandbox (see "Running standalone"
  below) — the request/assertion logic itself is real and portable to a real
  deployment.
- `route.test.mjs` — unit tests for `checkHealth`/`checkWalletCreate`/
  `runSmokeTest` against an in-process mock HTTP server, covering: all
  services healthy → pass; one service down/503 → fail + non-zero exit code;
  wallet-create e2e failure → fail; a slow/hanging service → timeout → fail
  (not an infinite hang); mixed pass/fail → summary reports all of them, not
  just the first.

## How to run it manually

Against a locally running stack (e.g. `pnpm --filter @vellar/all-in-one start`,
or each service started individually per its own README):

```sh
SMOKE_BASE_URL=http://localhost node contrib/routes/issue-339-predeploy-smoke-test/route.mjs
```

Override the target list/ports if your local setup differs from the
`.env.example` defaults:

```sh
SMOKE_TARGETS='[{"name":"api-gateway","port":4000},{"name":"wallet-service","port":4001,"walletCreateCheck":true}]' \
  node contrib/routes/issue-339-predeploy-smoke-test/route.mjs
```

Exit code: `0` = all checks passed, safe to deploy; non-zero = at least one
check failed — the summary printed to stdout shows exactly which one(s).

## How to run it in CI

Add a step after the stack is up (e.g. after `docker compose up -d` /
starting `all-in-one`) and before a deploy step:

```yaml
- name: Pre-deploy smoke test
  run: node contrib/routes/issue-339-predeploy-smoke-test/route.mjs
  env:
    SMOKE_BASE_URL: http://localhost
```

Because the script's own `process.exit(1)` on failure, no extra `if` /
`continue-on-error` handling is needed — a failed smoke test fails the job
the normal way, blocking the deploy step that would follow it. A real
integration would move `route.mjs`'s logic into
`services/*/package.json`'s workspace (e.g. a root `pnpm smoke` script) so it
runs against the actually-started services rather than the mocks used here
in the sandbox.

## Running standalone (mocked responses)

```sh
node contrib/routes/issue-339-predeploy-smoke-test/route.mjs --demo
```

`--demo` starts an in-process mock server that answers `/health` for every
service and `/wallet/create` for wallet-service, then runs the real smoke
test against it — a self-contained way to see the script's output shape
without a real stack running.

## Tests

```sh
node contrib/routes/issue-339-predeploy-smoke-test/route.test.mjs
```
