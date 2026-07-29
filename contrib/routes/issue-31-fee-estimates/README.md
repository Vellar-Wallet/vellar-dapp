# Mock route: network fee estimates (Issue #31)

Standalone mock GET route handler under `contrib/routes/` that returns network fee estimates across three priority tiers (`low`, `medium`, `high`).

## Fee Values (Stroops)

Fee values are integer amounts representing stroops (1 XLM = 10,000,000 stroops):

- **low**: `100` stroops (base network minimum fee)
- **medium**: `500` stroops (standard priority fee)
- **high**: `1000` stroops (high priority fee)

## Run

```sh
node route.mjs
# fee-estimates mock listening on http://localhost:4031/fee-estimates
```

## Example

Request:

```
GET /fee-estimates
```

Response:

```json
{
  "status": "success",
  "unit": "stroops",
  "fees": {
    "low": 100,
    "medium": 500,
    "high": 1000
  }
}
```
