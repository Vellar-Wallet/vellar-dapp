# @vellar/permission-service

dApp origin permissions, extension connection records, revocation state.

## Health Check Endpoint

`permission-service` exposes a GET `/health` endpoint for orchestrator and deployment readiness probes:

- **Endpoint**: `GET /health`
- **Response (200 OK)**: `{ "status": "ok", "service": "permission-service" }` when the service and database dependency are healthy.
- **Response (503 Service Unavailable)**: `{ "status": "unavailable", "service": "permission-service" }` when database connectivity or dependency health checks fail.

