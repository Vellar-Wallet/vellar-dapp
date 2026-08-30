# Mock route: wallet balance (Issue #25)

Standalone mock GET route returning a fixed, hardcoded wallet balance. No real
chain or database access — for local UI/dev testing only.

## Run

```sh
node route.mjs
# wallet-balance mock listening on http://localhost:4025/wallet-balance
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /wallet-balance
```

Response:

```json
{
  "balance": "1250.5000000",
  "assetCode": "XLM"
}
```
