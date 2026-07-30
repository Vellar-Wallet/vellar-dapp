# Cross Asset Balance Suite

A self-contained route handler simulating cross-asset balance aggregation with conversion to a common display asset.

## Endpoints

### GET /raw-balances?accountId=<accountId>

Returns the raw balances for an account across multiple assets.

**Query Parameters:**
- `accountId`: Account identifier

**Response:**
```json
{
  "accountId": "user123",
  "balances": [
    { "asset": "ETH", "balance": 1.5 },
    { "asset": "USDC", "balance": 1000 },
    { "asset": "BTC", "balance": 0.05 },
    { "asset": "UNKNOWN", "balance": 100 }
  ]
}
```

### GET /aggregated-value?accountId=<accountId>&displayAsset=<displayAsset>

Aggregates the account's balances by converting all assets to a common display asset using fixed exchange rates. Assets with no known rate are excluded and listed in warnings.

**Query Parameters:**
- `accountId`: Account identifier
- `displayAsset`: Target asset for conversion (default: "USD")

**Response:**
```json
{
  "accountId": "user123",
  "displayAsset": "USD",
  "aggregatedValue": 5250.0,
  "breakdown": [
    { "asset": "ETH", "balance": 1.5, "rate": 3000, "convertedValue": 4500 },
    { "asset": "USDC", "balance": 1000, "rate": 1, "convertedValue": 1000 },
    { "asset": "BTC", "balance": 0.05, "rate": 15000, "convertedValue": 750 }
  ],
  "warnings": [
    "Asset UNKNOWN has no known rate to USD and was excluded"
  ]
}
```

## Running the Test

```bash
node test.ts
```

This test demonstrates an account with a mix of known and unknown rate assets.
