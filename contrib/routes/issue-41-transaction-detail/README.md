# Mock route: transaction detail (Issue #41)

Standalone mock GET route returning a single sample transaction record looked up
by a path parameter hash. Returns a 404 payload when the hash is not found.

## Run

```sh
node route.mjs
# transaction-detail mock listening on http://localhost:4041/transaction/<hash>
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /transaction/abc123def456
```

Response:

```json
{
  "hash": "abc123def456",
  "amount": "100.0000000",
  "assetCode": "XLM",
  "from": "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
  "to": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
  "timestamp": "2026-07-27T12:00:00Z",
  "memo": "payment for services"
}
```
