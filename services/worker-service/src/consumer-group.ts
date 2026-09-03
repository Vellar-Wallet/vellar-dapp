import { startWorkerLoop, type WorkerDeps, type WorkerLoopHandle } from "./loop";

// Domain-specific consumer groups (issue #354).
//
// The worker previously ran a single undifferentiated poll loop that handled
// all job types from one store. That makes it impossible to scale or monitor
// consumers by domain — a surge in verification jobs can't be absorbed by
// adding verification workers without also adding transaction workers, and
// per-domain metrics are not available.
//
// A ConsumerGroup is a named, independently-scalable wrapper around
// startWorkerLoop. Each group:
//   - operates on its OWN job store (domain isolation: a verification group
//     never touches the transaction store and vice versa)
//   - has its own concurrency setting (parallelism — how many loops run at once)
//   - exposes a labelled `domain` for logging/metrics
//
// The group only adds the domain label + multi-instance management on top of the
// existing loop primitive; all job-processing logic stays in loop.ts/verify.ts.

export interface ConsumerGroupOptions {
  /** Human-readable domain label, e.g. "verification" or "transaction".
   * Used in log lines and (in future) per-domain metrics labels. */
  domain: string;
  /** How many parallel worker loops to run in this group. Each loop claims its
   * own batch independently, so N instances = N×batchSize throughput.
   * Default: 1. */
  concurrency?: number;
  /** All other loop dependencies (store, executor, resolver, timings, …). */
  workerDeps: WorkerDeps & { idleDelayMs?: number; busyDelayMs?: number };
}

export interface ConsumerGroupHandle {
  /** Domain label this group was created with. */
  readonly domain: string;
  /** Stop all running worker loops in this group. */
  stop(): void;
}

/**
 * Start a domain-specific consumer group. Creates `concurrency` independent
 * worker loops all pointing at the same `store`, so each loop claims its own
 * batch atomically (the store's `claimSubmitted` is the contention point —
 * this is the same guarantee as running N separate processes, just in-process).
 *
 * Returns a handle to stop the whole group at once.
 *
 * @example
 * ```ts
 * const verificationGroup = startConsumerGroup({
 *   domain: "verification",
 *   concurrency: 2,
 *   workerDeps: { store, executor, resolver, idleDelayMs: 5000 },
 * });
 *
 * // Later, on shutdown:
 * verificationGroup.stop();
 * ```
 */
export function startConsumerGroup(options: ConsumerGroupOptions): ConsumerGroupHandle {
  const { domain, concurrency = 1, workerDeps } = options;

  // Tag log lines with the domain and instance index so operators can tell
  // groups apart in mixed logs.
  const baseLog = workerDeps.log ?? { info: () => {}, error: () => {} };

  const loops: WorkerLoopHandle[] = [];
  for (let i = 0; i < concurrency; i++) {
    const instanceLabel = concurrency > 1 ? `[${domain}#${i}]` : `[${domain}]`;
    const log = {
      info: (msg: string) => baseLog.info(`${instanceLabel} ${msg}`),
      error: (msg: string, err?: unknown) => baseLog.error(`${instanceLabel} ${msg}`, err),
    };
    loops.push(startWorkerLoop({ ...workerDeps, log }));
  }

  return {
    domain,
    stop() {
      for (const loop of loops) loop.stop();
    },
  };
}
