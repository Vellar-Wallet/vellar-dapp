# Mock route: transactions by date range (Issue #29)

Standalone mock GET route handler under `contrib/routes/` filtering transactions by optional date range parameters (`from`, `to`).

## Query Parameters

- **from**: Optional ISO 8601 date string (e.g. `2026-07-01`)
- **to**: Optional ISO 8601 date string (e.g. `2026-07-15`)

## Run

```sh
node route.mjs
```

## Example

```
GET /transactions-by-date?from=2026-07-01&to=2026-07-15
```
