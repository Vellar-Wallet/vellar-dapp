# Route suite: multi step account merge readiness (Issue #95)

Self contained route handlers that walk a sample account through three stages:
inspection, blocker resolution, and a final merge readiness confirmation.

Everything is in memory in `route.mjs`; no account is ever touched and no merge
is ever built.

## The three stages

1. **Inspect** (`GET /inspect`) — what stands between this account and a merge,
   ranked worst first.
2. **Resolve** (`POST /resolve`) — clear blockers one at a time, in any order.
   Severity ranks them for a human; it does not gate the calls.
3. **Confirm** (`POST /confirm`) — issue the readiness record, but only once
   nothing is outstanding.

The confirmation is the point of the suite. While any blocker remains, `/confirm`
refuses with `409` and names what is left. The record it eventually issues pins
the blocker set it was issued against — `resolvedBlockers` and `totalBlockers` —
so it cannot be quietly reused as evidence for a different state of the account.

`GET /readiness` reports whether an account would pass without issuing anything;
being ready is not the same as being confirmed, and the payload distinguishes
the two.

## Sample accounts

| Account          | Blockers                                                 |
| ---------------- | -------------------------------------------------------- |
| `GA_BLOCKED`     | Four: two `high`, one `medium`, one `low`                |
| `GA_ONE_BLOCKER` | One `high` blocker                                       |
| `GA_READY`       | None — ready at inspection, confirmable with no resolves |

## Endpoints

### `GET /inspect?account=<id>`

The account profile plus its blockers, sorted `high` → `medium` → `low`, each
tagged with whether it has been resolved yet.

```json
{
  "account": {
    "account": "GA_BLOCKED",
    "balance": "1250.5000000",
    "trustlines": 3,
    "signers": 2,
    "openOffers": 1,
    "flags": 1
  },
  "blockers": [
    {
      "id": "extra-signers",
      "severity": "high",
      "message": "2 signers present; a merge requires the master key alone",
      "resolved": false
    }
  ],
  "blockerCount": 4,
  "outstandingCount": 4
}
```

An unknown account responds `404` with the list of known sample accounts.

### `POST /resolve`

Marks one blocker resolved.

Request:

```json
{ "account": "GA_BLOCKED", "blocker": "extra-signers" }
```

Response:

```json
{
  "blocker": "extra-signers",
  "severity": "high",
  "alreadyResolved": false,
  "account": "GA_BLOCKED",
  "ready": false,
  "outstanding": ["open-trustlines", "open-offers", "account-flags"],
  "resolved": ["extra-signers"],
  "totalBlockers": 4
}
```

`blocker` names what this call resolved; `resolved` is the full list cleared so
far. Resolution is idempotent — re-resolving returns `alreadyResolved: true`
rather than failing, since the end state is the same. A blocker that is not on
this account responds `404 blocker_not_found`, including one that exists on a
different sample account.

### `GET /readiness?account=<id>`

Whether the account is ready, and what is still in the way if not.

```json
{
  "account": "GA_BLOCKED",
  "ready": true,
  "outstanding": [],
  "resolved": ["extra-signers", "open-trustlines", "open-offers", "account-flags"],
  "totalBlockers": 4,
  "confirmed": false,
  "confirmationId": null
}
```

### `POST /confirm`

Issues the merge readiness confirmation.

Request:

```json
{ "account": "GA_BLOCKED" }
```

Response (`201`):

```json
{
  "account": "GA_BLOCKED",
  "ready": true,
  "confirmationId": "8c41…",
  "confirmedAt": "2026-01-01T00:00:00.000Z",
  "resolvedBlockers": ["extra-signers", "open-trustlines", "open-offers", "account-flags"],
  "totalBlockers": 4,
  "alreadyConfirmed": false
}
```

Response with blockers outstanding (`409`):

```json
{
  "error": "not_ready",
  "account": "GA_BLOCKED",
  "ready": false,
  "outstanding": ["open-trustlines"],
  "resolved": ["extra-signers", "open-offers", "account-flags"],
  "totalBlockers": 4
}
```

Re-confirming returns the original record with `alreadyConfirmed: true` and a
`200` rather than minting a second confirmation id.

## Run

```sh
node route.mjs
# merge-readiness-suite mock listening on http://localhost:4095/inspect
```

## Testing

Walks `GA_BLOCKED` through the full sequence — inspect, a refused confirmation,
blocker-by-blocker resolution, the readiness flip, and the issued record — plus
idempotent re-resolution, a blocker belonging to another account, the no-blocker
account confirming with no resolves, per-account isolation, and a mutated
response not corrupting the blocker table:

```sh
node route.test.mjs
```
