# @vellar/lifecycle-service

Account inspection, blocker detection, cleanup planning, merge validation

## Architecture

lifecycle-service is a **stateless service** that does not maintain its own database. It reads account state directly from the Stellar Horizon API to perform account inspections and validation. As a result, this service has never required database migrations.

## Issue #353 Investigation

During cleanup of issue #353, lifecycle-service was audited for unused migration scripts. Investigation confirmed that:
- No migration scripts have ever existed in this service
- No drizzle schema directory is present
- The service operates statelessly against the Horizon API
- No database cleanup was needed

This service's stateless design means it will never require migration management.
## Structured logging

Cleanup plan execution (`POST /lifecycle/execute`) emits one structured JSON
log entry per cleanup step it builds, via the shared `logEvent` helper (see
[`docs/observability.md`](../../docs/observability.md) for the general format).

| Event                   | Context fields                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `cleanup.step.built`    | `accountId`, `destination`, `outcome: "built"`, `stepIndex`, `stepCount`, `title`, `hash`      |
| `cleanup.plan.executed` | `accountId`, `destination`, `outcome: "no_steps"` — emitted when the plan has nothing to clean |

Example entry (pino JSON):

```json
{
  "level": 30,
  "event": "cleanup.step.built",
  "accountId": "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
  "destination": "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
  "outcome": "built",
  "stepIndex": 1,
  "stepCount": 1,
  "title": "Clean up the account",
  "hash": "6f83e0982be2efc58d0e7fbb35c2f20e2f22a5e9e2e9f25faa2cebde3562c2a5"
}
```

Each entry carries the **account id** and the **step outcome** so operators can
audit exactly what a cleanup plan execution produced (issue #304).
