# @vellar/permission-service

dApp origin permissions, extension connection records, revocation state.

## Health Check Endpoint

`permission-service` exposes a GET `/health` endpoint for orchestrator and deployment readiness probes:

- **Endpoint**: `GET /health`
- **Response (200 OK)**: `{ "status": "ok", "service": "permission-service" }` when the service and database dependency are healthy.
- **Response (503 Service Unavailable)**: `{ "status": "unavailable", "service": "permission-service" }` when database connectivity or dependency health checks fail.

## Configuration

`PERMISSION_CACHE_TTL_MS` controls how long origin permissions remain in the
in-memory cache. It defaults to `300000` (5 minutes). Values must be between
`1000` (1 second) and `86400000` (24 hours), inclusive; invalid values use the
default.
