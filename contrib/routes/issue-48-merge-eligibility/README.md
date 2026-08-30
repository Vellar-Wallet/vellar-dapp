# Mock route: merge eligibility (Issue #48)

Standalone mock GET route returning whether a sample account is eligible for a
merge operation, looked up by an `accountId` path parameter. No real chain or
database access.

## Run

```sh
node route.mjs
# merge-eligibility mock listening on http://localhost:4048/accounts/:accountId/merge-eligibility
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /accounts/acc_1001/merge-eligibility
```

Response:

```json
{
  "accountId": "acc_1001",
  "eligible": true,
  "reasons": []
}
```

An ineligible account keeps the same shape and fills in `reasons`:

```
GET /accounts/acc_1002/merge-eligibility
```

```json
{
  "accountId": "acc_1002",
  "eligible": false,
  "reasons": ["account_has_open_trustlines", "account_has_subentries"]
}
```

An account id that isn't in the sample dataset returns a 404-style payload:

```
GET /accounts/acc_9999/merge-eligibility
```

```json
{
  "error": "not_found",
  "message": "No merge eligibility record found for account \"acc_9999\""
}
```

## Sample dataset

| accountId  | eligible | reasons                                                 |
| ---------- | -------- | ------------------------------------------------------- |
| `acc_1001` | `true`   | —                                                       |
| `acc_1002` | `false`  | `account_has_open_trustlines`, `account_has_subentries` |
| `acc_1003` | `false`  | `balance_below_reserve`                                  |
| `acc_1004` | `true`   | —                                                       |
