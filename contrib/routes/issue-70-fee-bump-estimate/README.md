# Mock route: fee bump transaction estimation (Issue #70)

Standalone mock POST route simulating fee bump transaction fee estimation.
Suggested fees come from a fixed per-priority lookup table. No real chain
or database access.

## Run

```sh
node route.mjs
# fee-bump-estimate mock listening on http://localhost:4070/fee-bump-estimate
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
POST /fee-bump-estimate
Content-Type: application/json

{ "txHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "priority": "high" }
```

Response:

```json
{
  "txHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "priority": "high",
  "suggestedFee": 2000,
  "unit": "stroops"
}
```

`priority` must be one of `low`, `medium`, `high` (case-insensitive); their
fixed lookup-table fees are `100`, `500`, and `2000` stroops respectively.
`txHash` must be a hex string; missing or invalid values return `400`.
