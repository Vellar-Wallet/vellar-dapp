# Mock route: policy conflict suite (Issue #118)

Simulates multiple spending policies applying to the same account. A check endpoint resolves which policy governs a given transfer using a defined precedence rule (highest precedence number wins = most restrictive).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/list-active` | Lists active policies and their types. |
| POST | `/check-transfer` | Resolves which policy governs a transfer. Body: `{ "amount": 300, "toAddress": "GABC" }` |

## Precedence Rule

The policy with the **highest precedence number** wins (most restrictive). If multiple policies conflict, all conflicts are returned with the winning one identified.

## Policies (built-in)

| ID | Type | Rule | Precedence |
|----|------|------|------------|
| pol_A | spending-limit | max 500/day | 1 |
| pol_B | spending-limit | max 200/day | 2 |
| pol_C | allowlist | only GABC, GDEF | 0 |

## Run

```sh
node route.mjs
# policy-conflict mock listening on http://localhost:4118
```

## Test

```sh
node route.test.mjs
```

## Example — transfer blocked by spending limit

```
POST /check-transfer
{ "amount": 300, "toAddress": "GABC" }
```

```json
{
  "allowed": false,
  "governedBy": "pol_B",
  "reason": "amount 300 exceeds limit 200",
  "allConflicts": [
    { "policyId": "pol_B", "reason": "amount 300 exceeds limit 200", "precedence": 2 }
  ]
}
```
