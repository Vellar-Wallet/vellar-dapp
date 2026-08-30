# Mock route: rate limit info (Issue #53)

Standalone mock GET route returning a JSON payload that describes sample rate
limit values, mirroring the common `X-RateLimit-*` response headers as body
fields. No real chain, database, or rate limiter is involved.

## Run

```sh
node route.mjs
# rate-limit-info mock listening on http://localhost:4153/rate-limit-info
```

Port 4153 is the default because 4053 is already taken by
`contrib/routes/full-cleanup-merge-suite`. Override with `PORT=... node route.mjs`.

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /rate-limit-info
```

Response:

```json
{
  "limit": 1000,
  "remaining": 987,
  "resetAt": "2026-07-20T09:16:00.000Z"
}
```

## Fields

| Field       | Type             | Meaning                                                                 |
| ----------- | ---------------- | ----------------------------------------------------------------------- |
| `limit`     | number           | Calls allowed per window. Plain integer, not a string.                  |
| `remaining` | number           | Calls left in the current window. Integer, `0 <= remaining <= limit`.   |
| `resetAt`   | string, ISO 8601 | UTC instant the current window ends and `remaining` returns to `limit`. |

The sample quota is 1000 calls per fixed 60 second window, with 13 already
consumed. Windows are aligned to the Unix epoch rather than to the time of the
request, so every caller inside the same window sees the same `resetAt`; a
request landing exactly on a boundary reports the next boundary, never one that
has already passed.

`handleRequest` accepts an optional `now` (epoch milliseconds) so tests can pin
the clock:

```js
handleRequest({ now: Date.parse("2026-07-20T09:15:37.500Z") });
// resetAt: "2026-07-20T09:16:00.000Z"
```
