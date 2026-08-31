# Session Silent Refresh Suite (Issue #112)

Dependency-free mock routes for checking a session, expiring a sample session, and attempting a silent refresh with a simulated current time.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/session/check-session?now=1060000` | Reports whether the sample session is active or expired. |
| POST | `/session/expire` | Expires the session. Body may include `{ "now": 1060000 }` or `{ "expiresAt": 1060000 }`. |
| POST | `/session/silent-refresh` | Refreshes an expired session only during the grace period. Body may include `{ "now": 1060000 }`. |

The default grace period is 5 minutes (`300000` ms). Refreshing at the exact expiry time or exactly at the grace-period boundary is allowed. Once the boundary is passed, the route returns `401` with `reauthentication_required`.

## Run

```sh
node route.mjs
# session-silent-refresh suite listening on http://localhost:4112
```

## Test

```sh
node route.test.mjs
```

The exported `createState` and `handleRequest` functions make the route deterministic and keep state in memory for direct tests. No database, chain, or external dependency is required.