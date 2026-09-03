# Mock route: vesting schedule calculation (Issue #142)

Standalone mock route that computes how much of a sample vesting schedule
has released as of a provided reference date. In-memory only, no chain,
RPC, or database access.

## Sample schedule

A linear, cliff-free vest of `12000` tokens from `2026-01-01T00:00:00.000Z`
to `2027-01-01T00:00:00.000Z`.

## Run

```sh
node route.mjs
# vesting-calculation listening on http://localhost:4142
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /vesting/calculation?referenceDate=2026-06-01`

Response (`200`):

```json
{
  "referenceDate": "2026-06-01T00:00:00.000Z",
  "totalAmount": 12000,
  "released": 4931.51,
  "remaining": 7068.49
}
```

Before the schedule start, `released` is `0` and `remaining` equals the
total. After the schedule end, `released` equals the total and `remaining`
is `0`.

### Validation

| Status | `error`                    | Cause                                        |
| ------ | -------------------------- | --------------------------------------------- |
| 400    | `missing_reference_date`   | `referenceDate` query parameter not provided |
| 400    | `invalid_reference_date`   | `referenceDate` is not a parseable date      |
| 405    | `method_not_allowed`       | Wrong HTTP method on a known path            |
| 404    | `not_found`                | Unknown path                                  |
