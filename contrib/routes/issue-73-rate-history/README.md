# Mock route: exchange rate history with time buckets (Issue #73)

Standalone mock GET route returning XLM/USD exchange rate history, bucketed
by hour or day, from a fixed set of 30 hardcoded sample rate points spanning
just over a day. No real chain or database access.

## Run

```sh
node route.mjs
# rate-history mock listening on http://localhost:4073/rate-history?bucket=hourly|daily
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /rate-history?bucket=hourly
```

Response (truncated):

```json
{
  "bucket": "hourly",
  "buckets": [
    { "bucket": "2026-07-27T00", "rate": 0.118, "samples": 1 },
    { "bucket": "2026-07-27T01", "rate": 0.119, "samples": 1 }
  ]
}
```

Request:

```
GET /rate-history?bucket=daily
```

Response:

```json
{
  "bucket": "daily",
  "buckets": [
    { "bucket": "2026-07-27", "rate": 0.11917, "samples": 24 },
    { "bucket": "2026-07-28", "rate": 0.116, "samples": 6 }
  ]
}
```

`bucket` accepts `hourly` (default) or `daily`; any other value falls back
to `hourly`. Each bucket's `rate` is the average of the sample points that
fall within it.
