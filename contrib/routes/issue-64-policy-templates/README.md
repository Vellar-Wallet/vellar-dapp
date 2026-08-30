# Mock route: policy templates with parameter schemas (Issue #64)

Standalone mock GET route returning a fixed list of sample policy
templates, each with a schema describing its configurable parameters. No
real chain or database access.

## Run

```sh
node route.mjs
# policy-templates mock listening on http://localhost:4064/policy-templates
```

## Test

```sh
node route.test.mjs
```

## Endpoint

### `GET /policy-templates`

Response (`200`):

```json
{
  "templates": [
    {
      "id": "tpl_spending_limit",
      "name": "spending-limit",
      "description": "Caps the total amount that can be spent within a rolling time window.",
      "parameters": [
        { "name": "maxAmount", "type": "string", "required": true },
        { "name": "asset", "type": "string", "required": true },
        { "name": "windowSeconds", "type": "number", "required": true }
      ]
    },
    {
      "id": "tpl_allowlist",
      "name": "allowlist",
      "description": "Restricts outgoing payments to a fixed set of pre-approved recipient addresses.",
      "parameters": [
        { "name": "allowedRecipients", "type": "string[]", "required": true },
        { "name": "allowUnlistedBelow", "type": "string", "required": false }
      ]
    },
    {
      "id": "tpl_multisig",
      "name": "multisig",
      "description": "Requires a minimum number of signer approvals before a transaction is executed.",
      "parameters": [
        { "name": "signers", "type": "string[]", "required": true },
        { "name": "threshold", "type": "number", "required": true }
      ]
    },
    {
      "id": "tpl_time_lock",
      "name": "time-lock",
      "description": "Delays execution of a transaction until a specified time has elapsed.",
      "parameters": [
        { "name": "delaySeconds", "type": "number", "required": true },
        { "name": "cancellable", "type": "boolean", "required": false }
      ]
    }
  ]
}
```

`route.test.mjs` verifies every template has an `id`, a `name`, and a
non-empty `parameters` array where each parameter has a non-empty `name`,
a recognized `type` (`string`, `number`, `boolean`, `string[]`,
`number[]`), and a boolean `required` field.
