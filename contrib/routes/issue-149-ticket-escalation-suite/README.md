# Mock route suite: support ticket escalation workflow (Issue #149)

Standalone mock route suite that escalates a support ticket through
priority levels if it remains unresolved past a simulated time threshold.
In-memory only, no chain, RPC, or database access. State resets whenever
the process restarts.

## Escalation model

Priority levels, in order: `low -> medium -> high -> urgent`. A ticket
escalates one level for every full 24 simulated hours it has been open,
capping at `urgent`. A resolved ticket stops escalating and its priority is
frozen at whatever it last reached.

## Run

```sh
node route.mjs
# ticket-escalation-suite listening on http://localhost:4149
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /tickets`

Creates a ticket at `low` priority, timestamped with a simulated `now`.

Body:

```json
{ "subject": "Payment stuck", "now": "2026-01-01T00:00:00.000Z" }
```

Response (`201`):

```json
{
  "id": "ticket_0001",
  "subject": "Payment stuck",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "resolved": false,
  "priority": "low"
}
```

### `GET /tickets/:id/check-escalation?now=...`

Recomputes and persists the ticket's priority based on how long it has
been open as of the simulated `now`. Safe to call repeatedly; the ticket
never de-escalates.

Response (`200`):

```json
{ "id": "ticket_0001", "priority": "high", "resolved": false, "escalated": true }
```

A resolved ticket returns its frozen priority and `escalated: false`
regardless of `now`.

### `POST /tickets/:id/resolve`

Marks a ticket resolved so it stops escalating.

Response (`200`):

```json
{ "id": "ticket_0001", "resolved": true }
```

### Validation

| Status | `error`             | Cause                                          |
| ------ | ------------------- | ------------------------------------------------ |
| 400    | `invalid_subject`   | `subject` missing, empty, or not a string        |
| 400    | `missing_now`       | `now` not provided (create body or query param)  |
| 400    | `invalid_now`       | `now` is not a parseable date                    |
| 400    | `invalid_ticket_id` | Ticket id missing from the path                  |
| 404    | `not_found`         | Unknown ticket id or path                        |
| 405    | `method_not_allowed`| Wrong HTTP method on a known path                |

## Notes

`resetState()` is exported so a test can reset the ticket store and id
counter between runs. The test script covers a ticket checked before the
threshold (no escalation) and one checked well past it (escalated, then
capped at `urgent`).
