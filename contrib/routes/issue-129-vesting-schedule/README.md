# Mock route: sample vesting schedule (Issue #129)

Standalone mock GET route that returns a fixed sample token vesting
schedule for an account. No chain, RPC, or database access — the schedule
is a static in-memory sample.

## Run

```sh
node route.mjs
# vesting-schedule mock listening on http://localhost:4129/vesting-schedule
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /vesting-schedule
```

Response:

```json
{
  "account": "GABC123SAMPLEACCOUNT",
  "asset": "VELLAR",
  "releases": [
    { "date": "2026-01-15T00:00:00.000Z", "amount": "1000.0000000" },
    { "date": "2026-04-15T00:00:00.000Z", "amount": "1500.0000000" },
    { "date": "2026-07-15T00:00:00.000Z", "amount": "2000.0000000" },
    { "date": "2026-10-15T00:00:00.000Z", "amount": "2500.0000000" }
  ]
}
```

`releases` entries are always in chronological order by `date`. A wrong
method returns `405` with `{ "error": "method_not_allowed" }`; any other
path returns `404` with `{ "error": "not_found" }`.
