# Mock route: network fee estimates (Issue #31)

Standalone mock GET route handler returning priority tier network fee estimates (`low`, `medium`, `high`) in stroops.

## Fee Values (Stroops)

- **low**: `100` stroops
- **medium**: `500` stroops
- **high**: `1000` stroops

## Run

```sh
node route.mjs
```

## Example

```
GET /fee-estimates
```
