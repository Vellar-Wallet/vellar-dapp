# Mock route: exchange rates (Issue #40)

Standalone mock GET route returning a fixed set of sample asset exchange rates.
Supports a `base` query parameter to filter rates for a single base asset.

## Run

```sh
node route.mjs
# exchange-rates mock listening on http://localhost:4040/exchange-rates
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /exchange-rates?base=XLM
```

Response:

```json
{
  "rates": [
    { "base": "XLM", "quote": "USD", "rate": "0.12" },
    { "base": "XLM", "quote": "EUR", "rate": "0.11" }
  ]
}
```
