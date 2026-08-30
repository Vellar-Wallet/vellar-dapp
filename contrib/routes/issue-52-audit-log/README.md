# Mock route: audit log (Issue #52)

Standalone mock GET route returning a fixed array of sample audit log entries.
Each entry has an `actor`, an `action`, and an ISO-8601 UTC `timestamp`. No real
chain or database access.

## Run

```sh
node route.mjs
# audit-log mock listening on http://localhost:4052/audit-log
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /audit-log
```

Response:

```json
{
  "entries": [
    {
      "actor": "user_1001",
      "action": "wallet.created",
      "timestamp": "2025-03-01T08:15:22Z"
    },
    {
      "actor": "admin_2001",
      "action": "contract.verified",
      "timestamp": "2025-03-02T11:30:05Z"
    },
    {
      "actor": "system",
      "action": "session.expired",
      "timestamp": "2025-03-03T00:00:00Z"
    }
  ]
}
```

## Sample dataset

Six entries with six distinct actions, ordered oldest to newest:
`wallet.created`, `policy.updated`, `contract.verified`, `transaction.signed`,
`session.expired`, `trustline.removed`.
