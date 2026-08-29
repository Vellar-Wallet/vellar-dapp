# Registry Publisher (B6)

Backend module that publishes verified wasm hashes to the on-chain verified-registry contract.

## Usage

Called from the worker-service after a verification reaches a "verified" outcome.

```js
import { publishToRegistry } from "./index.mjs";

const result = await publishToRegistry(wasmHash, "verified", {
  txSender: stellarSdkSender,
  adminSecret: process.env.REGISTRY_ADMIN_SECRET,
  registryContractId: process.env.REGISTRY_CONTRACT_ID,
  network: "testnet",
  metrics: domainMetrics.verification,
  log: logger,
});
```

## Behaviour

| Status | Action |
|---|---|
| `verified` | Publish to registry. Idempotent — already-published hashes are a no-op. |
| `failed` / `pending` | Skipped. No chain interaction. |

## Failure handling

- **Idempotency**: If the hash is already in the registry (`AlreadyVerified`), treated as success.
- **Transient failure**: Error is thrown so the caller can retry. The verification record is preserved in the store.
- **Metrics**: `success` and `failure` counters incremented via the shared metrics helper.

## Tests

```sh
node contrib/packages/registry-publisher/index.test.mjs
```
