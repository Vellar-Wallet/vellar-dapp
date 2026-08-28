# Mock route: rate limit sliding window (Issue #115)

Implements a sliding window rate limit counter for a sample client id using a simulated current time value.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hit` | Record a hit. Body: `{ "clientId": "abc", "time": 1000000 }`. Returns 429 if over limit. |
| GET | `/status` | Check remaining allowance. Query: `?clientId=abc&time=1000000` |

## Defaults

- Window: 60 seconds
- Limit: 5 hits per window

## Run

```sh
node route.mjs
# rate-limit-sliding mock listening on http://localhost:4115
```

## Test

```sh
node route.test.mjs
```

## Example — fill window then get rejected

```
POST /hit
{ "clientId": "alice", "time": 1000000 }
```
→ `{ "clientId": "alice", "allowed": true, "remaining": 4, ... }`

After 5 hits:
```
POST /hit
{ "clientId": "alice", "time": 1000500 }
```
→ 429: `{ "clientId": "alice", "allowed": false, "remaining": 0, ... }`
