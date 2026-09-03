# Route suite: cleanup planning with ordered blockers (Issue #93)

Self contained route handlers that inspect a sample account, plan a cleanup as a
chain of dependent steps, and let a caller mark those steps complete — but only
in order.

Everything is in memory in `route.mjs`; no account is ever touched.

## Why the order matters

The ordering is a real dependency chain, not a display preference. Each step
carries `dependsOn`, the id of the step immediately before it, and a step is
only completable once that dependency is done:

| Step               | Depends on the previous step because                                  |
| ------------------ | --------------------------------------------------------------------- |
| `cancel-offers`    | Open offers hold reserves and can refill balances a later step clears |
| `drain-balances`   | A trustline cannot be closed while it still holds a balance           |
| `close-trustlines` | Each trustline holds a base reserve the account cannot release        |
| `remove-signers`   | Extra signers hold reserves and can block a single-key finalize       |
| `clear-flags`      | Auth flags must be cleared before the account can be finalized        |
| `finalize`         | Confirms every preceding step landed                                  |

Marking a step out of order is refused with `409` and changes nothing, so a
caller cannot skip ahead to `finalize` and claim a cleanup that never happened.

A step that does not apply to an account is left out of that account's plan
entirely, and the chain re-anchors around the gap — the remaining steps stay
consecutively numbered from 1 with an unbroken `dependsOn` chain. `finalize` is
always present and always last, so every plan has a step that means "done".

## Sample accounts

| Account      | Findings                                            |
| ------------ | --------------------------------------------------- |
| `GA_DIRTY`   | All five cleanup findings — a six step plan         |
| `GA_PARTIAL` | One trustline only — `close-trustlines`, `finalize` |
| `GA_CLEAN`   | Nothing to clean — `finalize` alone                 |

## Endpoints

### `GET /inspect?account=<id>`

Returns the sample account and what needs cleaning, without creating a plan.

```json
{
  "account": {
    "account": "GA_DIRTY",
    "balance": "1250.5000000",
    "openOffers": 2,
    "fundedTrustlines": 1,
    "trustlines": 3,
    "extraSigners": 2,
    "flags": 1
  },
  "findings": [
    { "kind": "cancel-offers", "detail": "Cancel 2 open offer(s)" },
    { "kind": "drain-balances", "detail": "Move out 1 funded trustline balance(s)" }
  ],
  "needsCleanup": true
}
```

An unknown account responds `404` with the list of known sample accounts.

### `POST /plan`

Builds the ordered plan for an account.

Request:

```json
{ "account": "GA_DIRTY" }
```

Response (`201`):

```json
{
  "planId": "3f2a…",
  "account": "GA_DIRTY",
  "steps": [
    {
      "id": "cancel-offers",
      "order": 1,
      "title": "Cancel open offers",
      "detail": "Cancel 2 open offer(s)",
      "reason": "Open offers hold reserves and can refill balances a later step clears",
      "dependsOn": null,
      "status": "pending",
      "completedAt": null
    }
  ],
  "completedCount": 0,
  "totalSteps": 6,
  "nextStep": "cancel-offers",
  "complete": false
}
```

### `GET /plan/:planId`

Returns the plan as it stands, in the same shape, with `nextStep` naming the
only step currently completable and `complete` reporting whether the chain is
finished.

### `POST /plan/:planId/complete`

Marks one step complete. Only `nextStep` is accepted.

Request:

```json
{ "step": "cancel-offers" }
```

Response (`200`) — the completed step id plus the refreshed plan:

```json
{
  "completed": "cancel-offers",
  "completedCount": 1,
  "nextStep": "drain-balances",
  "complete": false
}
```

Refusals are distinguished so a caller can tell what went wrong:

- `409 step_out_of_order` — a real step in this plan, but not the one that is
  due. Reports `expected`, `received`, and the `blockedBy` dependency.
- `409 step_already_complete` — the step is in this plan and already done.
- `404 step_not_in_plan` — not a step of this plan at all, with `planSteps`
  listing the ones that are.
- `404 plan_not_found` — unknown `planId`.

None of the refusals mutate the plan.

## Run

```sh
node route.mjs
# cleanup-planning-suite mock listening on http://localhost:4093/inspect
```

## Testing

Covers inspection of all three sample accounts, the chained plan shape, skipping
ahead by one step and to the end, re-completing a finished step, a step outside
the plan, a full in-order walk to completion, plans staying independent of one
another, and a mutated response not corrupting stored state:

```sh
node route.test.mjs
```
