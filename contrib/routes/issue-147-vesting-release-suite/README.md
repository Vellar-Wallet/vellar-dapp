# Mock route suite: vesting release schedule (Issue #147)

Standalone mock route suite that tracks a vesting schedule and reports the
claimable amount as a simulated current time advances through several
release points. In-memory only, no chain, RPC, or database access. State
resets whenever the process restarts.

## Sample schedule

`10000` tokens released in four equal tranches of `2500`, on
`2026-01-01`, `2026-04-01`, `2026-07-01`, and `2026-10-01` (all UTC). No
linear vesting between tranches — the full tranche amount vests the moment
its date is reached.

## Run

```sh
node route.mjs
# vesting-release-suite listening on http://localhost:4147
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /vesting/schedule`

Returns the static release plan.

Response (`200`):

```json
{
  "totalAmount": 10000,
  "releases": [
    { "date": "2026-01-01T00:00:00.000Z", "amount": 2500 },
    { "date": "2026-04-01T00:00:00.000Z", "amount": 2500 },
    { "date": "2026-07-01T00:00:00.000Z", "amount": 2500 },
    { "date": "2026-10-01T00:00:00.000Z", "amount": 2500 }
  ]
}
```

### `GET /vesting/claimable?now=2026-05-01`

Returns the amount vested and claimable as of the simulated `now`, net of
anything already claimed.

Response (`200`):

```json
{
  "now": "2026-05-01T00:00:00.000Z",
  "totalAmount": 10000,
  "vested": 5000,
  "claimed": 0,
  "claimable": 5000
}
```

### `POST /vesting/claim?now=2026-05-01`

Claims whatever is currently claimable as of the simulated `now` and adds
it to the running claimed total.

Response (`200`):

```json
{ "now": "2026-05-01T00:00:00.000Z", "claimedThisRequest": 5000, "totalClaimed": 5000 }
```

### Validation (`/vesting/claimable` and `/vesting/claim`)

| Status | `error`       | Cause                                 |
| ------ | ------------- | -------------------------------------- |
| 400    | `missing_now` | `now` query parameter not provided    |
| 400    | `invalid_now` | `now` is not a parseable date         |
| 405    | `method_not_allowed` | Wrong HTTP method on a known path |
| 404    | `not_found`   | Unknown path                           |

## Notes

`resetState()` is exported so a test can reset the running claimed total
between runs.
