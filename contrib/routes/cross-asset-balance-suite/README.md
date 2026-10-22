# Cross-Asset Balance Suite

A standalone Node.js HTTP example that returns sample account balances and their value converted to USD using fixed sample rates. It uses only Node built-ins and keeps all sample data in memory.

Run the test with `node --test server.test.js`. Start the server with `node server.js`; it listens on `127.0.0.1:3000` by default, or on the port in `PORT`.

## Endpoints

### `GET /raw-balances?account=demo-account`

Returns the unconverted sample balances for the requested account:

```json
{
  "account": "demo-account",
  "balances": [
    { "asset": "XLM", "balance": 100 },
    { "asset": "USDC", "balance": 25 },
    { "asset": "MYSTERY", "balance": 7 }
  ]
}
```

Unknown accounts return `404` with an `error` field.

### `GET /aggregated-value?account=demo-account`

Returns the converted total in USD, the per-asset conversion details, and a `warnings` array. The fixed rates are XLM = 0.12 USD, USDC = 1 USD, and EURC = 1.08 USD. Assets without a rate are excluded from `total` and listed in `warnings`.
