# @vellar/api-gateway

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
