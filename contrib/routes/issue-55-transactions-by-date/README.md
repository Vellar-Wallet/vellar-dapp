# Mock route: transactions by date range (Issue #55)

Standalone mock GET route listing sample transactions, filtered by an optional
start and end date. No real chain or database access.

The sample set holds 12 transactions spread across January to August 2026, so a
range filter has something to actually narrow.

## Run

```sh
node route.mjs
# transactions-by-date mock listening on http://localhost:4055/transactions-by-date
```

## Test

```sh
node route.test.mjs
```

## Query parameters

| Parameter | Required | Meaning                                              |
| --------- | -------- | ---------------------------------------------------- |
| `from`    | no       | Lower bound, inclusive. Omit to leave it open-ended. |
| `to`      | no       | Upper bound, inclusive. Omit to leave it open-ended. |

Both bounds accept either a bare `YYYY-MM-DD` date or a full ISO 8601
timestamp such as `2026-03-01T23:59:59Z`. Bare dates are read as UTC.

Both bounds are inclusive. A bare date in `to` is widened to the end of that
day, so `to=2026-03-01` includes a transaction stamped `2026-03-01T23:59:59Z`
rather than only the midnight tick. `from=X&to=X` therefore means "everything
that happened on day X".

Results come back oldest first, whatever order the underlying sample data is
stored in.

## Example

Request:

```
GET /transactions-by-date?from=2026-03-01&to=2026-03-22
```

Response:

```json
[
  {
    "id": "tx_03",
    "amount": "200.0000000",
    "asset": "XLM",
    "timestamp": "2026-03-01T00:00:00Z"
  },
  {
    "id": "tx_04",
    "amount": "3.2500000",
    "asset": "USDC",
    "timestamp": "2026-03-01T23:59:59Z"
  },
  {
    "id": "tx_05",
    "amount": "75.0000000",
    "asset": "XLM",
    "timestamp": "2026-03-22T18:03:00Z"
  }
]
```

## Empty results are not errors

This route always answers `200` with an array. A window that matches nothing
comes back as `[]`:

```
GET /transactions-by-date?from=2027-01-01&to=2027-12-31
```

```json
[]
```

That covers an inverted range (`from` later than `to`) as well, which is empty
by definition rather than a rejection.

An unparseable bound is dropped instead of rejected, for the same reason: the
route still answers with a list, it just does not narrow on that side. So
`?from=yesterday&to=2026-02-28` behaves as `?to=2026-02-28`.
