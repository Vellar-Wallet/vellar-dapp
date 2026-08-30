# Mock route: sample withdrawal limit (Issue #132)

Standalone mock route module returning a fixed sample daily withdrawal limit
and the amount already used for an account, plus a derived `remaining`
field. In-memory sample dataset only, no chain or database access.

## Run

```sh
node route.mjs
# withdrawal-limit mock listening on http://localhost:4132/withdrawal-limit/{accountId}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /withdrawal-limit/:accountId`

Response (`200`):

```json
{ "accountId": "acct_001", "limit": 5000, "used": 1250, "remaining": 3750 }
```

`remaining` is always `limit - used`. Accounts not in the sample dataset
(`acct_001`, `acct_002`) fall back to a default limit of `1000` with `0`
used.
