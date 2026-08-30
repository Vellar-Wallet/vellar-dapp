# Route suite: policy authoring, validation, and dry run (Issue #92)

Self contained route handlers that walk a policy through three stages before
it could ever be deployed. Everything is in memory in `route.mjs`. No chain or
database is touched, and there is no endpoint in this suite that makes a
policy live.

## The stages

1. **Author** (`POST /policies`) — save a draft. Only the request shape is
   checked (`name`, `rules` present and typed); rule semantics are not
   evaluated yet, so an author can save a draft while still tuning it.
2. **Validate** (`POST /policies/:id/validate`) — checks every rule name is
   supported and every rule's value has the right shape. Recorded on the
   policy as `validated` or `invalid`.
3. **Dry run** (`POST /policies/:id/dry-run`) — simulate the policy against
   sample transactions, or a caller-supplied set, and report what would pass
   and what would fail. **Gated on validation**: a policy that has never been
   validated, or whose last validation failed, is refused with
   `409 not_validated` rather than run anyway.

That gate is the point of the suite. Running an unvalidated policy would
report a clean pass for a rule that is silently broken (e.g. `maxAmount` set
to a string) — the exact failure mode the dry run exists to catch, just
surfacing one step too late.

## Supported rules

| Rule                | Value shape            | A transaction fails when                        |
| ------------------- | ---------------------- | ----------------------------------------------- |
| `maxAmount`         | positive finite number | its `amount` is greater than the cap            |
| `allowedAssets`     | non-empty `string[]`   | its `asset` is not in the list                  |
| `allowedRecipients` | non-empty `string[]`   | its `recipient` is not in the list              |
| `requireMemo`       | boolean                | `true` and its `memo` is absent, empty or blank |

Validation checks the **shape** of a rule's value (e.g. `maxAmount` must be a
positive number). Dry run checks the **effect** of a rule against real
transactions. An unsupported rule name fails validation immediately, listing
the offending name so a typo like `maxAmmount` is never silently ignored.

## Endpoints

### `POST /policies`

```json
{ "name": "Treasury cap", "rules": { "maxAmount": 500 } }
```

Returns `201` with the new draft (`status: "draft"`, `validation: null`,
`lastDryRun: null`).

### `GET /policies/:id`

Returns the policy's current stage, its last validation result, and its last
dry run result (all `null` until each stage has run).

### `POST /policies/:id/validate`

Re-validating is always allowed, including after a policy has already passed
— there is no separate edit endpoint, so re-validating is how a caller
re-checks a policy whose rules changed. Returns every rule the policy gets
wrong, not just the first.

```json
{
  "status": "invalid",
  "validation": {
    "valid": false,
    "errors": [
      {
        "rule": "maxAmmount",
        "reason": "unsupported rule; supported: maxAmount, allowedAssets, allowedRecipients, requireMemo"
      }
    ]
  }
}
```

### `POST /policies/:id/dry-run`

```json
{ "transactions": [{ "id": "tx_a", "amount": "900", "asset": "XLM" }] }
```

`transactions` is optional — omit it to run against the built-in
`SAMPLE_TRANSACTIONS`. Response mirrors the dry-run route's shape:

```json
{
  "persisted": false,
  "summary": { "simulated": 1, "passed": 0, "failed": 1 },
  "results": [
    {
      "index": 0,
      "id": "tx_a",
      "decision": "fail",
      "violations": [{ "rule": "maxAmount", "reason": "amount 900 exceeds maxAmount 500" }]
    }
  ]
}
```

`persisted: false` is always present — a dry run is never mistaken for a
deploy. The result is also stored on the policy as `lastDryRun`.

| Response | Meaning                                                            |
| -------- | ------------------------------------------------------------------ |
| `200`    | Ran (validate) or simulated (dry-run)                              |
| `400`    | Malformed request (`name`, `rules`, or `transactions`)             |
| `404`    | `policy_not_found`                                                 |
| `409`    | `not_validated` — dry run attempted before/after failed validation |

## Run

```sh
node route.mjs
# policy-authoring-dry-run-suite mock listening on http://localhost:4092/policies
```

Override the port with `PORT=5000 node route.mjs`.

```sh
ID=$(curl -s -X POST localhost:4092/policies \
  -H 'content-type: application/json' \
  -d '{"name":"Treasury cap","rules":{"maxAmount":500}}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST localhost:4092/policies/$ID/validate
curl -X POST localhost:4092/policies/$ID/dry-run -H 'content-type: application/json' -d '{}'
```

## Test

```sh
node route.test.mjs
```

Covers the full lifecycle: drafting, an unsupported rule name and a malformed
rule value both failing validation with every offending rule reported, a dry
run refused both before any validation and after a failed one, a passing dry
run against the sample set and against a caller-supplied set, and routing.
