# Mock route: transaction rejection explainer (Issue #23 / A11)

Standalone mock route that evaluates a proposed transaction's authorization
contexts against the safety policy rules **before** signing, and names the
specific rule responsible when it would be rejected, instead of surfacing an
unexplained on-chain failure.

## Why this matches the contract

The classification and evaluation logic in [route.mjs](route.mjs) is a direct
mirror of
[`contrib/contracts/safety-policy/src/lib.rs`](../../contracts/safety-policy/src/lib.rs)
(`parse_authorization_context` and `Contract::policy__`):

- A `transfer` call with a valid recipient and a positive amount is
  classified as a **token transfer**; anything else invoked on a contract is
  an **other contract call**; anything malformed or non-contract is
  **unknown**.
- A token transfer is rejected only if its amount exceeds
  `maxTransferAmount`.
- Every other contract call is rejected — the policy only allows token
  transfers.
- An unknown/unclassifiable interaction is rejected and reported as
  `unknown-interaction`, not silently treated as safe. `route.test.mjs`
  documents the case-by-case trace against the Rust source that establishes
  this.
- The contract's `policy__` loop panics on the **first** rejecting
  interaction and never evaluates the rest; this route short-circuits the
  same way, so the rule reported here is always the one the contract would
  actually act on.
- An empty context list is rejected, since the contract also rejects it.

### Preventing divergence

This is a plain JS mock, not a binding to the compiled contract, so there is
no automated link keeping the two in sync. If the Rust policy logic changes,
this file's `classifyContext` / `evaluateInteraction` must change in the same
PR — that is a manual, reviewed step, called out again as a comment at the
top of [route.mjs](route.mjs). A change to one without the other should be
caught in review.

### Wiring into the UI

Actually surfacing this in the transaction review step (before the passkey
prompt) requires touching `apps/`, which is outside `contrib/`'s scope for
external contributors per [CONTRIBUTING.md](../../../CONTRIBUTING.md). This
suite provides the reusable `evaluateTransactionSafety(config, contexts)`
function that step is meant to call; wiring it into the actual review screen
is left to a maintainer.

## Run

```sh
node route.mjs
# tx-rejection-explainer mock listening on http://localhost:4023/policy/simulate-rejection
```

## Test

```sh
node route.test.mjs
```

## Request

```json
{
  "config": { "maxTransferAmount": 100 },
  "contexts": [{ "contract": "CTOKEN", "fnName": "transfer", "args": ["from", "GDEST", 900] }]
}
```

`contexts` mirrors a Soroban `Context::Contract`: `args` is positional, with
`args[1]` as the recipient and `args[2]` as the amount for a `transfer` call.
Omit `contexts` (or send `[]`) to check the "no interactions" case.

## Response

```json
{
  "verdict": "rejected",
  "rule": "max-transfer-amount",
  "reason": "amount 900 exceeds maxTransferAmount 100",
  "interactions": [
    {
      "classification": "transfer",
      "decision": "rejected",
      "rule": "max-transfer-amount",
      "reason": "..."
    }
  ]
}
```

`verdict` is `"allowed"` or `"rejected"`. On rejection, `rule` is one of:

| Rule                  | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `max-transfer-amount` | A token transfer's amount exceeds the configured limit |
| `non-transfer-call`   | The interaction calls something other than `transfer`  |
| `unknown-interaction` | The interaction could not be classified                |
| `no-interactions`     | The context list was empty                             |

`interactions` lists every context with its own classification and decision,
even though only the first rejection determines the overall verdict — useful
for showing the user the full picture, not just the one that stopped it.

## Rejected requests

- `config.maxTransferAmount` missing, not a number, or not positive: `400 invalid_request`.
- `contexts` present but not an array: `400 invalid_request`.
