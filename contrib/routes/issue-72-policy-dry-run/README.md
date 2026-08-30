# Mock route: policy dry run (Issue #72)

Standalone mock POST route that simulates a proposed policy against a set of
sample transactions and reports which ones would pass and which would fail.

Nothing is persisted and no chain or database is touched. The response is the
entire result, and it says so: every successful response carries
`"persisted": false`.

## Run

```sh
node route.mjs
# policy-dry-run mock listening on http://localhost:4072/policy/dry-run
```

## Test

```sh
node route.test.mjs
```

## Request

```json
{
  "policy": { "maxAmount": 100, "allowedAssets": ["XLM"] },
  "transactions": [
    { "id": "tx_a", "amount": "25.0000000", "asset": "XLM", "recipient": "GAAA", "memo": "rent" },
    { "id": "tx_b", "amount": "900.0000000", "asset": "XLM", "recipient": "GAAA", "memo": "pay" }
  ]
}
```

`policy` is required. `transactions` is optional -- omit it to run against the
built-in sample set exported as `SAMPLE_TRANSACTIONS`.

## Supported policy rules

Every rule is optional. A policy with no rules passes everything.

| Rule                | Type       | A transaction fails when                        |
| ------------------- | ---------- | ----------------------------------------------- |
| `maxAmount`         | number     | its `amount` is greater than the cap            |
| `allowedAssets`     | `string[]` | its `asset` is not in the list                  |
| `allowedRecipients` | `string[]` | its `recipient` is not in the list              |
| `requireMemo`       | boolean    | `true` and its `memo` is absent, empty or blank |

Rule names follow the parameter vocabulary of the policy templates route.

## Response

```json
{
  "persisted": false,
  "summary": { "simulated": 2, "passed": 1, "failed": 1 },
  "results": [
    { "index": 0, "id": "tx_a", "decision": "pass", "violations": [] },
    {
      "index": 1,
      "id": "tx_b",
      "decision": "fail",
      "violations": [{ "rule": "maxAmount", "reason": "amount 900 exceeds maxAmount 100" }]
    }
  ]
}
```

Results come back in the order they were submitted, one entry per transaction.
`index` is the position in the submitted list; `id` is the transaction's own id,
or `null` if it did not carry one. `violations` is always an array, empty on a
pass, and lists _every_ rule a transaction breaks rather than stopping at the
first -- the point of a dry run is to see all the damage in one pass.

## Rejected requests

- `policy` missing or not an object, `transactions` present but not an array,
  or an entry in it that is not an object: `400 invalid_request`.
- A rule name the route does not implement: `400 unsupported_rule`, listing
  both the offending names and the supported ones.

That last one is deliberate. A misspelled rule such as `maxAmmount` would
otherwise be silently ignored, and the dry run would report a clean pass for a
policy that enforces nothing -- the worst possible answer from a tool whose only
job is to tell you what a policy would do.
