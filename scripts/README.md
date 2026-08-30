# @vellar/scripts

Operational scripts for gating deploys, referenced from the affected
services' READMEs rather than duplicated there.

- **`deploy-health-gate.ts`** (#334, #336) — polls a service's `/health`
  until it reports healthy for several consecutive checks (or times out).
  Used both as a pre-cutover verification step for wallet-service's
  [rollback runbook](../services/wallet-service/README.md#deploy-rollback-runbook-334)
  and as the first stage of api-gateway's
  [canary gate](../services/api-gateway/README.md#canary-deploy-stage-336).

- **`canary-error-budget-gate.ts`** (#336) — scrapes a service's real
  `/metrics` (Prometheus text, from `@vellar/service-kit`'s
  `registerMetrics`) twice, a window apart, and computes the 5xx error rate
  within that window. Used as the promotion gate in
  [api-gateway's canary deploy stage](../services/api-gateway/README.md#canary-deploy-stage-336).

Both are plain functions (`runHealthGate`, `runCanaryGate`) with injectable
fetch/sleep/clock, so they're unit-tested without any real network calls or
timers — see the sibling `.test.ts` files — and are also runnable directly
as CLIs via `tsx`.

```sh
pnpm --filter @vellar/scripts test
```
