# Route suite: merge builder (Issue #122)

Self-contained route handlers that validate a merge destination, build a
mock merge transaction, and report the estimated reclaimed balance.

## Endpoints

### POST /validate-destination

Validates whether the given destination is acceptable for a merge.

Request:
```json
{ "destination": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB" }
```

Response (valid):
```json
{ "valid": true }
```

Response (invalid):
```json
{ "valid": false, "error": "invalid_destination", "destination": "..." }
```

### POST /build

Builds a mock merge transaction. Refuses to proceed if the destination
is invalid (same validation as `/validate-destination`).

Request:
```json
{ "destination": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB" }
```

Response:
```json
{
  "source": "GABCDEF...",
  "destination": "GABCDEF...",
  "amount": "1250.5000000",
  "memo": "merge",
  "txReady": true
}
```

### GET /estimate-reclaim

Returns the source balance minus a fixed reserve amount.

```json
{
  "source": "GABCDEF...",
  "sourceBalance": "1250.5000000",
  "reserve": "1.0000000",
  "estimatedReclaim": "1249.5000000"
}
```

## Run

```sh
node route.mjs
# merge-builder-suite mock listening on http://localhost:4051
```

## Test

```sh
node route.test.mjs
```
