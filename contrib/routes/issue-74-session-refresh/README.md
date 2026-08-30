# Mock route: session refresh flow (Issue #74)

Standalone mock route module simulating a session refresh flow. Session
state is kept in memory (seeded with one already-expired sample session)
and resets whenever the process restarts. No real chain or database access.

## Run

```sh
node route.mjs
# session-refresh mock listening on http://localhost:4074/session-refresh/{check,refresh}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /session-refresh/check`

Returns whether the current sample session is expired.

Response:

```json
{
  "token": "tok_a1b2c3d4e5f6",
  "expiresAt": "2026-07-27T22:00:00.000Z",
  "expired": true
}
```

An optional `now` query parameter (ISO timestamp) overrides what "current
time" is used for the expiry comparison, for deterministic testing.

### `POST /session-refresh/refresh`

Issues a new token and a new `expiresAt` (12 hours ahead of `now`),
replacing the in-memory session.

Response:

```json
{
  "token": "tok_9f8e7d6c5b4a",
  "issuedAt": "2026-07-28T00:00:00.000Z",
  "expiresAt": "2026-07-28T12:00:00.000Z"
}
```

Optional body `{ "now": "<ISO timestamp>" }` overrides the issue time used
to compute the new `expiresAt`, for deterministic testing.
