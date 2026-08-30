# @vellar/policy-service

Policy schema validation, template registry, simulation and deployment orchestration

## Deploy path timeout budgets (#327)

Every RPC call in the policy deploy path (`getAccount`, `simulateTransaction`,
`prepareTransaction`, `sendTransaction`, and the post-submission
`getTransaction` polling loop) is bounded by two independently-configurable
timeout budgets, both enforced by this service's own timer (see
`deploy.ts`'s `withTimeoutError` — `@stellar/stellar-sdk`'s `rpc.Server`
constructor accepts a `timeout` option in its TypeScript types, but as of SDK
16.0.1 it has no effect on the underlying HTTP client and is not relied on):

| Env var | Default | What it bounds |
|---|---|---|
| `DEPLOY_RPC_TIMEOUT_MS` | `10000` (10s) | Each individual RPC call. A network stall on any one call fails fast with `PolicyDeployError` code `deploy_rpc_timeout`, distinct from every other deploy failure code. |
| `DEPLOY_POLL_TIMEOUT_MS` | `60000` (60s) | The overall budget for the polling loop that waits for a submitted transaction to confirm. Exceeding this (without any single `getTransaction` call itself timing out) fails with code `deploy_timeout`. |

Both are separate from the transaction's own on-chain timebounds (fixed at
60s, per the network's own rejection ceiling for timebounds set further out —
not configurable, since it isn't a network-call timeout at all).
