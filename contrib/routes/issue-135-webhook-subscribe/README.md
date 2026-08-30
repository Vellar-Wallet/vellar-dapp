# Mock route: webhook subscribe (Issue #135)

Standalone mock route that accepts a POST body describing a new webhook
subscription and echoes back a created record with a generated id.
In-memory only, no chain, RPC, or database access. State resets whenever the
process restarts.

## Run

```sh
node route.mjs
# webhook-subscribe listening on http://localhost:4135
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /webhooks/subscribe`

Body:

```json
{ "url": "https://example.com/hook", "events": ["payment.settled"] }
```

Response on success (`201`):

```json
{
  "id": "sub_0001",
  "url": "https://example.com/hook",
  "events": ["payment.settled"],
  "createdAt": "2026-08-25T12:00:00.000Z"
}
```

### Validation

| Status | `error`          | Cause                                      |
| ------ | ---------------- | ------------------------------------------- |
| 400    | `invalid_url`    | `url` missing, empty, or not a string       |
| 400    | `invalid_events` | `events` missing, empty, or not an array    |
| 405    | `method_not_allowed` | Wrong HTTP method on a known path      |
| 404    | `not_found`      | Unknown path                                |

## Notes

`resetState()` is exported so a test can reset the subscription counter and
in-memory store between runs.
