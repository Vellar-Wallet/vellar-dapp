# Mock route: transaction history (Issue #26)

Standalone mock GET route returning a fixed array of sample transaction
records. No real chain or database access.

## Run

```sh
node route.mjs
# transaction-history mock listening on http://localhost:4026/transactions
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /transactions?limit=2
```

Response:

```json
[
  {
    "hash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "amount": "50.0000000",
    "timestamp": "2026-07-20T09:15:00Z"
  },
  {
    "hash": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    "amount": "12.5000000",
    "timestamp": "2026-07-21T14:32:00Z"
  }
]
```

Omit `limit` (or pass an invalid value) to get the full 5-item sample set.
