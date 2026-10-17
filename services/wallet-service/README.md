# @vellar/wallet-service

Wallet metadata, account preferences, session/device records, audit logs.

## RPC Retry & Circuit Breaker Policy

During Stellar RPC endpoint degradation or transient outages, `wallet-service` applies exponential backoff with randomized jitter and an automated circuit breaker to prevent retry storms:

- **Exponential Backoff**: Retries failed submission attempts up to `maxRetries` (default: 3) using base delay `initialDelayMs` (default: 100ms), multiplier factor 2, capped at `maxDelayMs` (default: 3000ms), combined with 0-50% random jitter to avoid thundering herd problems.
- **Circuit Breaker**: Tracks consecutive submission/transport failures. When failures reach `failureThreshold` (default: 5), the circuit state transitions to `OPEN` for `resetTimeoutMs` (default: 30000ms). Submissions attempted while the breaker is OPEN immediately reject with `CircuitBreakerOpenError` without placing further load on the upstream RPC network.

## Route Reference

### GET /wallet/session (#517)

Fetches the caller's active session capability. The session ID travels strictly in the `Authorization: Bearer <sessionId>` header.

- **Optional Query**: `?contractId=<address>`: When provided, verifies that the active bearer session is bound to the requested contract.
- **200 OK**: Active session found and valid:
  ```json
  {
    "id": "e6a2139e-...",
    "contractId": "CAFK7NMQOT...",
    "network": "testnet",
    "createdAt": "2026-08-01T00:00:00.000Z",
    "lastActiveAt": "2026-08-01T00:00:00.000Z",
    "expiresAt": "2026-08-08T00:00:00.000Z"
  }
  ```
- **401 Unauthorized**: No active session exists, the session has expired, or the contract ID does not match:
  ```json
  {
    "error": "unauthorized"
  }
  ```
  _Note:_ Missing, expired, and unknown sessions return identical `401 unauthorized` responses by design to prevent credential/account enumeration while allowing clients (`apps/web/lib/sessions.ts`) to reliably branch to onboarding or reconnect UI.

### POST /wallet/jobs & GET /wallet/jobs/:recordId (#516)

- **POST /wallet/jobs**: Enqueues a build or verification job. Returns `202 Accepted`:
  ```json
  {
    "enqueued": true,
    "recordId": "rec-001",
    "status": "queued",
    "correlationId": "corr-xyz"
  }
  ```
- **GET /wallet/jobs/:recordId**: Returns the job status distinguishing `queued`, `building`, and `stuck` states:
  ```json
  {
    "recordId": "rec-001",
    "contractId": "CAFK7NMQOT...",
    "status": "queued",
    "createdAt": "2026-08-01T12:00:00.000Z",
    "updatedAt": "2026-08-01T12:00:00.000Z"
  }
  ```
  Jobs in `building` status whose last update exceeds the configurable age threshold (default 5 minutes) transition dynamically to `stuck` without requiring external events.

### POST /wallet/submit (#515, #520)

- Enforces idempotent replay detection keyed on the SHA-256 hash of the signed transaction envelope.
- Repeated submissions of the exact same signed envelope return the original submission result `{ hash }` without re-submitting or rejecting.
- Distinct signed envelopes for the same logical intent produce distinct hashes and are handled independently.
- Confirmed submissions automatically evict cached balance entries for affected wallet contracts to prevent serving stale on-chain balances.

## Deploy rollback runbook (#334)

### What this covers, honestly

The issue asks for blue/green environment support with a traffic cutover
step and automated rollback. This project deploys as a **single combined
process** (`@vellar/all-in-one`, which bundles this service) to Railway or
Render — see `railway.json` / `render.yaml` at the repo root — with no
orchestrator (no k8s/ECS; `infra/README.md`'s `k8s/` reference is aspirational,
not yet built) and no built-in traffic-splitting or dual-environment
primitive on either platform's free tier. A real blue/green cutover — two
live environments, a router that shifts traffic between them, automatic
rollback on a failed health check — isn't buildable against this infra today
without first standing up that orchestration layer, which is out of scope
for this issue.

What **is** real and shippable today: a documented, testable procedure for
verifying a new deploy before it's trusted, and a fast, deliberate rollback
path using the platform's native mechanisms. That's what's below.

### Pre-cutover health verification

Before treating a fresh deploy as live, gate it on
[`scripts/deploy-health-gate.ts`](../../scripts/deploy-health-gate.ts) —
it polls `/health` until it reports healthy for several checks in a row
(not just once, to rule out a service that's still flapping right after
startup):

```sh
tsx scripts/deploy-health-gate.ts \
  --url https://<your-deploy>.onrender.com/health \
  --consecutive 5 \
  --timeout-ms 120000
```

Exit code `0` means the deploy answered healthy 5 times in a row within two
minutes — safe to consider it the new "standby-verified" environment. Exit
code `1` means it never stabilized; do not point users at it, and go
straight to the rollback steps below.

`/health` here already reflects DB readiness, not just process liveness —
`registerHealth`'s `isReady` probe (`@vellar/service-kit`) returns 503 when
the persistence layer is degraded (FIX 7), so this gate genuinely verifies
the new deploy can serve real requests, not just that the process started.

### Rollback procedure

Both Railway and Render keep prior deploys and support rolling back to one
without a rebuild:

- **Render**: Dashboard → the service → **Deploys** tab → find the last
  known-good deploy → **Rollback to this deploy**. Render redeploys that
  exact build; no code change or push needed.
- **Railway**: Dashboard → the service → **Deployments** tab → find the last
  known-good deployment → the `⋮` menu → **Redeploy**. Same effect: the
  prior build goes live without a rebuild.

After rolling back, re-run the health gate against the now-live (rolled
back) URL to confirm the rollback itself is healthy before considering the
incident resolved:

```sh
tsx scripts/deploy-health-gate.ts --url https://<your-deploy>.onrender.com/health --consecutive 5
```

### Staging rehearsal

Because there's no separate blue/green environment to test cutover against,
rehearse the procedure end-to-end on a staging deploy before you need it for
real: deploy a change to staging, run the health gate against it, then
deliberately roll it back one step and re-run the gate against the rolled
-back build. If both gate runs pass, the rollback mechanism itself is
confirmed working — the actual "test the full cutover and rollback in a
staging environment" the issue asks for, scoped to what a single-environment
deploy target can rehearse.
