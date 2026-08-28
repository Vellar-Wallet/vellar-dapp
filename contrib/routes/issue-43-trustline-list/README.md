# Mock route: trustline list (Issue #43)

Standalone mock GET route returning a fixed array of sample trustline records
for an account. Each entry includes an asset code, issuer, and balance.

## Run

```sh
node route.mjs
# trustline-list mock listening on http://localhost:4043/trustline-list
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /trustline-list
```

Response:

```json
{
  "trustlines": [
    {
      "assetCode": "XLM",
      "issuer": "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
      "balance": "1250.5000000"
    },
    {
      "assetCode": "USDC",
      "issuer": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
      "balance": "500.0000000"
    }
  ]
}
```
