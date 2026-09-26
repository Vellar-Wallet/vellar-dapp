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

## Account read caching and invalidation on merge (#287)

`GET`-equivalent account lookups (`/lifecycle/inspect`, `/lifecycle/plan`,
`/lifecycle/merge` all call the same `AccountReader.getAccount`) are cached
in-memory for a short TTL (`account-cache.ts`, default 30s) so a single
cleanup workflow — which reads the same account 2-3 times across those
endpoints — doesn't hit Horizon on every call. This is a per-process,
in-memory cache; it does not persist and does not violate this service's
stateless design (see "Architecture" above) since it's a pure read-through
optimization, never a source of truth.

**Invalidation:** `POST /lifecycle/merge` evicts both the source (merged-away)
and destination (balance-changed) account from the cache as soon as the merge
step is built and audit-logged — see the `lifecycle.merge.cache_invalidated`
log event. This is **optimistic**: this service only builds the unsigned
merge transaction; the client still has to sign and submit it (via
wallet-service) before the merge is final on-chain. There's no channel back
to this service to confirm that later submission succeeded, so invalidation
happens at the point the merge is committed to (not proven complete) — the
short TTL is the backstop if a particular merge is later abandoned or fails
to land, since the evicted entry just gets correctly re-fetched (still
showing the pre-merge state) rather than serving a stale value for the rest
of the TTL window regardless.

A caller that constructs the service with a plain (uncached) `AccountReader`
— every existing test in this package does this — gets no invalidation call
at all; there's nothing to invalidate.

## Cleanup Plan Response Schema (`/lifecycle/accounts/:id/cleanup-plan`)

Generates a pre-flight cleanup plan for an account before executing a merge into a destination address.

### Response JSON Schema

```json
{
  "accountId": "G...",
  "destination": "G...",
  "blockers": [
    {
      "type": "balance | trustline | offer | data",
      "description": "Human-readable description of blocker",
      "actionRequired": "Action required before merging"
    }
  ],
  "estimatedTransactions": 1,
  "mergeReady": true
}
```

### Example 1: Clean Account Ready to Merge

```json
{
  "accountId": "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
  "destination": "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
  "blockers": [],
  "estimatedTransactions": 1,
  "mergeReady": true
}
```

### Example 2: Account with Trustlines, Non-Zero Balances, and Data Entries

```json
{
  "accountId": "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
  "destination": "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
  "blockers": [
    {
      "type": "balance",
      "description": "Holds 50.00 USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "actionRequired": "Transfer or burn the USDC balance before removing its trustline"
    },
    {
      "type": "trustline",
      "description": "Trustline to USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "actionRequired": "Remove the USDC trustline (requires zero balance)"
    },
    {
      "type": "data",
      "description": "Managed data entry \"app_config\"",
      "actionRequired": "Delete the \"app_config\" data entry"
    }
  ],
  "estimatedTransactions": 2,
  "mergeReady": false
}
```
