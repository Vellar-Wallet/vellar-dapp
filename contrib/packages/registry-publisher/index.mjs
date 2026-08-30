/**
 * Registry Publisher — publishes verified wasm hashes to the on-chain
 * verified-registry contract.
 *
 * This module is the backend path that takes a completed successful
 * verification and records the corresponding wasm hash in the on-chain
 * registry. It is designed to be called from the worker-service after a
 * verification reaches a "verified" outcome.
 *
 * Requirements (B6):
 * - Trigger publication only for records that reached a verified outcome.
 * - Sign the registry write with the administrative key (server-side secret).
 * - Make publication idempotent — re-running for an already-published hash
 *   must not create a duplicate entry or fail.
 * - Handle registry write failures without losing the verification record.
 * - Increment observability counters for publication success and failure.
 */

const silentLog = { info: () => {}, error: () => {} };

/**
 * Publish a verified wasm hash to the on-chain registry.
 *
 * - Only publishes when `status === "verified"`. Returns early for any other
 *   status without contacting the chain.
 * - Idempotent: if the hash is already in the registry, the contract rejects
 *   with `AlreadyVerified`. We treat that as success (already published).
 * - On transient failure the error is thrown so the caller can retry; the
 *   verification record is preserved in the store.
 *
 * @param {string} wasmHash
 * @param {string} status - VerificationStatus from @vellar/types
 * @param {{
 *   txSender: { invokeContract(params: { contractId: string, method: string, args: unknown[], source: string, signWith: string }): Promise<{ txHash: string }> },
 *   adminSecret: string,
 *   registryContractId: string,
 *   network: "testnet" | "mainnet",
 *   metrics?: { inc(labels: { service: string, outcome: string, network: string }): void },
 *   log?: { info: (msg: string) => void, error: (msg: string, err?: unknown) => void }
 * }} deps
 * @returns {Promise<{ published: boolean, message: string }>}
 */
export async function publishToRegistry(wasmHash, status, deps) {
  const log = deps.log ?? silentLog;

  if (status !== "verified") {
    return { published: false, message: `Skipped: status is "${status}", not "verified".` };
  }

  try {
    const result = await deps.txSender.invokeContract({
      contractId: deps.registryContractId,
      method: "add",
      args: [wasmHash],
      source: deps.adminSecret,
      signWith: deps.adminSecret,
    });

    deps.metrics?.inc({
      service: "verification-service",
      outcome: "success",
      network: deps.network,
    });

    log.info(`Published wasm hash ${wasmHash} to registry (tx ${result.txHash}).`);
    return { published: true, message: `Published (tx ${result.txHash}).` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AlreadyVerified") || msg.includes("already")) {
      deps.metrics?.inc({
        service: "verification-service",
        outcome: "success",
        network: deps.network,
      });
      log.info(`Wasm hash ${wasmHash} already in registry — idempotent no-op.`);
      return { published: true, message: "Already in registry (idempotent no-op)." };
    }

    deps.metrics?.inc({
      service: "verification-service",
      outcome: "failure",
      network: deps.network,
    });
    log.error(`Failed to publish wasm hash ${wasmHash} to registry`, err);
    throw err;
  }
}
