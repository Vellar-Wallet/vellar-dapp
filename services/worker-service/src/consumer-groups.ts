/**
 * Verification-specific consumer group factory (issue #354).
 *
 * Do not confuse with ./consumer-group.ts (singular). That module is the
 * generic, domain-agnostic primitive that starts and labels worker loops.
 * This module is the thin per-domain layer: it binds the verification store,
 * executor and resolver to that primitive and fixes the domain label to
 * "verification". Add other domains here with their own factories; keep loop
 * mechanics there so the two files never grow duplicate implementations.
 */
import type { VerificationJobStore } from "./job-store";
import {
  startConsumerGroup,
  type ConsumerGroupHandle,
  type ConsumerGroupOptions,
} from "./consumer-group";
import type { BuildExecutor as Executor } from "./executor";
import type { ContractArtifactResolver as Resolver } from "./resolver";
import type { WorkerDeps } from "./loop";

type Logger = NonNullable<WorkerDeps["log"]>;

// Domain-specific consumer group definitions (issue #354).
//
// Each group has:
//   - a domain label
//   - its own dedicated job store (so groups never compete for the same queue)
//   - configurable concurrency
//   - shared execution machinery (Executor, Resolver)
//
// Add new domains (e.g. "transaction") by:
//   1. Defining a new store interface (e.g. TransactionJobStore)
//   2. Adding a factory function similar to createVerificationGroup
//   3. Calling it from index.ts

export interface VerificationGroupOptions {
  store: VerificationJobStore;
  executor: Executor;
  resolver: Resolver;
  /**
   * How many parallel loops to run. Each loop claims its own batch, so N
   * instances = N×batchSize throughput. Default: 1.
   */
  concurrency?: number;
  /** Polling delay when the queue is empty (ms). Default: 5000. */
  idleDelayMs?: number;
  /** Polling delay when jobs were processed (ms). Default: 250. */
  busyDelayMs?: number;
  log?: Logger;
}

/**
 * Create a verification consumer group. Handles jobs from the verification
 * store (artifact download, WASM verification, attestation submission).
 */
export function createVerificationGroup(options: VerificationGroupOptions): ConsumerGroupHandle {
  const {
    store,
    executor,
    resolver,
    concurrency = 1,
    idleDelayMs = 5000,
    busyDelayMs = 250,
    log,
  } = options;

  return startConsumerGroup({
    domain: "verification",
    concurrency,
    workerDeps: { store, executor, resolver, idleDelayMs, busyDelayMs, log },
  });
}

// Future domain: transaction processing (placeholder for #354 follow-on work).
//
// export interface TransactionGroupOptions {
//   store: TransactionJobStore;
//   signer: TransactionSigner;
//   submitter: TransactionSubmitter;
//   concurrency?: number;
//   log?: Logger;
// }
//
// export function createTransactionGroup(
//   options: TransactionGroupOptions,
// ): ConsumerGroupHandle {
//   return startConsumerGroup({
//     domain: "transaction",
//     concurrency: options.concurrency ?? 1,
//     workerDeps: { ...options },
//   });
// }
