# @vellar/api-gateway

Unified API entrypoint: CORS, rate limiting, security headers, body-size cap, CSRF mitigation, and reverse-proxy routing to downstream services.

---

## Architecture

The gateway is a single Fastify server. Every incoming request passes through a shared `onRequest` hook that enforces:

- **Body-size cap** (413) — checked on `Content-Length` before the body is streamed upstream.
- **Content-type enforcement** (415) — mutations (POST/PUT/PATCH) must send `application/json` (CSRF mitigation for a cookieless API).

Global plugins applied to all routes:

| Plugin | Purpose |
|---|---|
| `@fastify/helmet` | Security headers (HSTS, X-Frame-Options, nosniff, …) |
| `@fastify/cors` | Restricts browser callers to the configured origin(s) |
| `@fastify/rate-limit` | Per-IP request cap; `/health` is exempt |

---

## Route registration — `registerProxyRoute`

Every downstream service is proxied with the same three-field pattern (upstream URL, gateway prefix, rewrite prefix). Rather than repeating `app.register(proxy, { upstream, prefix, rewritePrefix })` for every route, use the shared helper:

```ts
import { registerProxyRoute } from "./register-proxy-route";

registerProxyRoute(app, {
  upstream: walletServiceUrl, // e.g. "http://localhost:4001"
  prefix: "/wallet",          // path the gateway exposes
  // rewritePrefix defaults to prefix — omit when they are the same
});
```

### Options

| Field | Type | Required | Description |
|---|---|---|---|
| `upstream` | `string` | yes | Base URL of the backend service |
| `prefix` | `string` | yes | Path prefix exposed by the gateway |
| `rewritePrefix` | `string` | no | Path forwarded to the upstream (defaults to `prefix`) |

When the gateway prefix and the upstream path differ — for example a future versioned route (`/v2/wallet` → `/wallet`) — pass `rewritePrefix` explicitly:

```ts
registerProxyRoute(app, {
  upstream: walletServiceUrl,
  prefix: "/v2/wallet",
  rewritePrefix: "/wallet",
});
```

### Current routes

| Gateway prefix | Upstream env var | Default upstream URL |
|---|---|---|
| `/wallet` | `WALLET_SERVICE_URL` | `http://localhost:4001` |
| `/lifecycle` | `LIFECYCLE_SERVICE_URL` | `http://localhost:4002` |
| `/policies` | `POLICY_SERVICE_URL` | `http://localhost:4003` |
| `/verification` | `VERIFICATION_SERVICE_URL` | `http://localhost:4004` |

---

## Configuration

All values can be set via environment variables or passed directly to `buildServer(options)` (useful in tests):

| Env var | Default | Description |
|---|---|---|
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed browser origin(s), comma-separated |
| `RATE_LIMIT_MAX` | `120` | Max requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in ms |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | Maximum request body size |
| `REQUEST_TIMEOUT_MS` | `30000` | Connection-level timeout |
| `PORT` | `4000` | Port the gateway listens on |
Unified API entrypoint: auth/session middleware, rate limiting, request tracing, client routing.

## CORS Security Policy & Review Cadence

The API Gateway enforces strict origin verification at the boundary:

- **Allowed Origins**: Defaults strictly to known web clients (`http://localhost:3000`, `https://app.vellar.wallet`, `https://vellar.wallet`) and extension origins (`chrome-extension://vellar-wallet-extension`).
- **Dynamic Configuration**: Overridden via comma-separated `CORS_ORIGIN` environment variable.
- **Review Cadence**: CORS origin configurations must be audited quarterly or whenever new client domains or browser extension IDs are onboarded.
- **Disallowed Origins**: Any unlisted origin fails preflight checks and will not receive an `Access-Control-Allow-Origin` header.
Unified API entrypoint: auth/session middleware, rate limiting, request tracing, client routing

## Circuit breaker for verification-service (#326)

`/verification/*` proxying to `verification-service` is protected by a
circuit breaker (`@vellar/service-kit`'s `createCircuitBreaker`) so a
downstream outage fails fast instead of cascading into slow gateway
responses:

| Env var | Default | Meaning |
|---|---|---|
| `VERIFICATION_CB_FAILURE_THRESHOLD` | `5` | Consecutive connection-level failures (timeouts, refused connections — NOT a normal 4xx/5xx from a reachable upstream) before the breaker opens. |
| `VERIFICATION_CB_COOLDOWN_MS` | `30000` | How long the breaker stays open before allowing one half-open trial call through. |

While open, requests to `/verification/*` respond `503` immediately with
`{"error": "verification_service_unavailable", "retryAfterMs": <n>}` —
no network attempt is made. State transitions
(`closed`↔`open`↔`half_open`) are logged and recorded in the
`vela_circuit_breaker_state_changes_total{breaker="verification-service"}`
Prometheus counter exposed at `/metrics`.

## Canary deploy stage (#336)

### What this covers, honestly

The issue asks for a canary stage that routes a percentage of production
traffic to a new version, gated by automated health checks. This project
deploys as a **single combined process** to Railway/Render (`railway.json`,
`render.yaml`) with no orchestrator and no traffic-splitting primitive on
either platform's free tier — there is no way to route "10% of traffic" to
one process and 90% to another without first standing up a router/mesh
layer, which is out of scope for this issue (see `infra/README.md`'s `k8s/`
note — aspirational, not yet built).

What's real and shippable today: this service already emits genuine
request-outcome metrics (`vela_http_requests_total`, labeled by status —
see `@vellar/service-kit`'s `registerMetrics`), so a **canary deployed as a
separate instance receiving its own (even if small/synthetic) traffic** can
be judged on its real error rate before being promoted. That's the gate
below — an automatable go/no-go check with a documented rollback trigger,
using metrics the service already produces, not a fabricated traffic split.

### Canary health + error-budget gates

Two scripts, meant to run in sequence against a canary instance's URL
before promoting it:

1. **[`scripts/deploy-health-gate.ts`](../../scripts/deploy-health-gate.ts)**
   — confirms the canary is even up and stable:
   ```sh
   tsx scripts/deploy-health-gate.ts --url https://<canary-url>/health --consecutive 5
   ```
2. **[`scripts/canary-error-budget-gate.ts`](../../scripts/canary-error-budget-gate.ts)**
   — once traffic is flowing to the canary, scrapes its `/metrics` twice,
   `--window-ms` apart, and computes the 5xx rate **within that window**
   (a delta, so a stale error from before the canary went live doesn't count
   against it forever):
   ```sh
   tsx scripts/canary-error-budget-gate.ts \
     --url https://<canary-url> \
     --window-ms 300000 \
     --max-error-rate 0.02 \
     --min-requests 20
   ```
   Exit `0` with a real (non-inconclusive) verdict means the canary's error
   rate is within budget — safe to promote. Exit `1` means the budget was
   exceeded. If it reports **inconclusive** (too few requests observed),
   that's not a pass — it means there isn't enough signal yet; wait for more
   traffic and re-run rather than promoting on a guess.

### Automated promotion gate

Both checks are meant to run as one CI step (or a manual pre-promotion
command) that only proceeds to promote/merge when both exit 0:

```sh
tsx scripts/deploy-health-gate.ts --url "$CANARY_URL/health" --consecutive 5 \
  && tsx scripts/canary-error-budget-gate.ts --url "$CANARY_URL" --window-ms 300000 --max-error-rate 0.02
```

### Rollback trigger

If either gate fails (non-zero exit), the documented response is: **do not
promote**, and roll the canary instance back to the last known-good build
via the platform's native rollback (Render: Deploys tab → Rollback; Railway:
Deployments tab → Redeploy a prior build — see the wallet-service README's
[rollback runbook](../wallet-service/README.md#rollback-procedure) for the
exact steps, which apply identically here). Re-run the health gate against
the rolled-back instance before considering the incident resolved.

### Staging rehearsal

Rehearse the full flow on staging before relying on it for a real
production canary: deploy a change to a staging instance, run both gates
against it, then deliberately introduce a failure (e.g. point
`--max-error-rate` at a threshold you know the current error rate exceeds)
to confirm the gate actually fails closed, not just that it can pass.
