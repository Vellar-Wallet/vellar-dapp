# Mock route suite: fee estimation across network load (Issue #117)

Standalone mock route suite that estimates a transaction fee from a
simulated network load level supplied in the request. No chain, RPC, or
database access — every value is fixed sample data.

## Run

```sh
node route.mjs
# fee-load suite listening on http://localhost:4117
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /fee-load/estimate`

Estimates a fee for the given simulated load level.

| Query | Required | Description |
| --- | --- | --- |
| `load` | yes | One of `low`, `medium`, `high` |
| `operations` | no | Integer 1-100, defaults to `1` |

The fee is the base fee per operation (100 stroops) multiplied by the load
multiplier and the operation count:

| Load | Multiplier | Fee per operation |
| --- | --- | --- |
| `low` | 1 | 100 stroops |
| `medium` | 4 | 400 stroops |
| `high` | 12 | 1200 stroops |

Request:

```
GET /fee-load/estimate?load=high&operations=2
```

Response:

```json
{
  "load": "high",
  "operations": 2,
  "multiplier": 12,
  "baseFeePerOperation": 100,
  "feePerOperation": 1200,
  "estimatedFee": 2400,
  "unit": "stroops"
}
```

Errors:

| Status | `error` | Cause |
| --- | --- | --- |
| 400 | `invalid_load` | `load` missing or not `low`/`medium`/`high` |
| 400 | `invalid_operations` | `operations` not an integer in 1-100 |

### `GET /fee-load/load-history`

Returns a fixed sample series of recent load observations, oldest first.

Response:

```json
{
  "samples": [
    { "observedAt": "2026-07-27T18:00:00.000Z", "load": "low" },
    { "observedAt": "2026-07-27T19:00:00.000Z", "load": "low" },
    { "observedAt": "2026-07-27T20:00:00.000Z", "load": "medium" },
    { "observedAt": "2026-07-27T21:00:00.000Z", "load": "high" },
    { "observedAt": "2026-07-27T22:00:00.000Z", "load": "high" },
    { "observedAt": "2026-07-27T23:00:00.000Z", "load": "medium" }
  ],
  "count": 6,
  "latest": "medium"
}
```

Any other path returns `404` with `{ "error": "not_found" }`; any method
other than `GET` returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

The folder is named `issue-117-fee-load-suite` to follow the
`contrib/routes/issue-<n>-<name>/` convention used by the sibling route
folders; the suite itself is the `fee-load-suite` described in the issue.
