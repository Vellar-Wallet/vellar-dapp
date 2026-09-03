# Mock route: session expiry (Issue #36)

Standalone mock GET route returning a fixed session record including an
expiry timestamp and a derived `expired` flag. No real chain or database
access.

## Run

```sh
node route.mjs
# session-expiry mock listening on http://localhost:4036/session-expiry
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /session-expiry
```

Response:

```json
{
  "sessionId": "sess_7f3a9c2e1b4d",
  "issuedAt": "2026-07-27T10:00:00.000Z",
  "expiresAt": "2026-07-27T22:00:00.000Z",
  "expired": true
}
```

`expired` is derived by comparing `expiresAt` to the current time. For
deterministic testing, an optional `now` query parameter (ISO timestamp)
overrides what "current time" is used for the comparison.
