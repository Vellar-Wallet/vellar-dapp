# Mock route: health check (Issue #39)

Standalone mock GET route returning a health check style JSON payload.

## This is a mock, not a real service check

The handler always reports `"ok"`. It does **not** probe Horizon, the database, the
API service, or any other dependency, and it will keep returning `"ok"` while those
are down. Treat it as a payload shape reference only — do not wire it into uptime
monitoring, load balancer health probes, or alerting.

The only real value in the response is the process uptime of whatever is running
this file.

## Run

```sh
node route.mjs
# health-check mock listening on http://localhost:4039/health
```

## Test

```sh
node route.test.mjs
```

## Request

```
GET /health
```

## Example

Response `200`:

```json
{
  "status": "ok",
  "service": "vellar-mock",
  "uptimeSeconds": 90,
  "startedAt": "2026-07-28T11:58:30.000Z",
  "timestamp": "2026-07-28T12:00:00.000Z"
}
```

| Field           | Notes                                                       |
| --------------- | ----------------------------------------------------------- |
| `status`        | Always `"ok"` — see the caveat above                        |
| `service`       | Fixed service identifier                                    |
| `uptimeSeconds` | Whole seconds since the process started, floored, never < 0 |
| `startedAt`     | ISO-8601 timestamp, `uptimeSeconds` before `timestamp`      |
| `timestamp`     | ISO-8601 timestamp of the response                          |

`handleRequest` accepts optional `now` and `uptimeSeconds` overrides so tests can
assert against fixed values rather than wall-clock time.
