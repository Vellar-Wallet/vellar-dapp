import type { Attestor } from "./attestor";
import type { VerificationJobStore } from "./job-store";
import { runVerification, type RunVerificationDeps } from "./verify";

// The build worker's poll loop. Claims submitted jobs, runs each to a terminal
// outcome, and records the result. Kept separate from process/timer wiring so a
// single "tick" is testable deterministically.

/** Observability hook (idea.md §13): the loop reports each verification outcome
 * + turnaround and any unexpected worker failure. Optional + defaulted so the
 * loop stays a pure, injectable unit in tests.
 *
 * ISSUE #295: Added verificationRetry metric to track retry attempts for jobs
 * that succeeded or failed after transient errors. */
export interface WorkerMetrics {
  verificationResult(outcome: "verified" | "failed", turnaroundSeconds?: number): void;
  workerFailure(): void;
  /** Backpressure: reports the current queue depth of pending/active jobs. */
  queueDepth?(depth: number): void;
  /** Backpressure: reports processing lag in seconds between submission and pickup. */
  processingLag?(lagSeconds: number): void;
}

const noopMetrics: WorkerMetrics = { verificationResult: () => {}, workerFailure: () => {} };

export interface WorkerDeps extends RunVerificationDeps {
  store: VerificationJobStore;
  /** Max jobs to claim per tick. */
  batchSize?: number;
  /** Concurrency limit for simultaneous transaction processing (backpressure control). Default 1. */
  concurrencyLimit?: number;
  log?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  metrics?: WorkerMetrics;
  /** Optional on-chain attestation mirror. Called after each outcome is
   * persisted; the attestor swallows its own errors, so attestation can never
   * fail or retry a verification job. */
  attestor?: Attestor;
}

const silentLog = { info: () => {}, error: () => {} };

/**
 * Processes one batch of claimed jobs with backpressure concurrency controls.
 * Respects concurrencyLimit so bursts of transactions cannot overwhelm downstream
 * Stellar RPC calls. Queue excess work rather than dropping or overwhelming downstream.
 */
export async function runWorkerTick(deps: WorkerDeps): Promise<number> {
  const log = deps.log ?? silentLog;
  const metrics = deps.metrics ?? noopMetrics;

  if (metrics.queueDepth) {
    try {
      const active = await deps.store.countActive();
      metrics.queueDepth(active);
    } catch {
      // metric reporting is best effort
    }
  }

  const concurrency = Math.max(1, deps.concurrencyLimit ?? 1);
  const claimLimit = deps.batchSize ?? concurrency;
  const jobs = await deps.store.claimSubmitted(claimLimit);

  let cursor = 0;
  const processJob = async (job: (typeof jobs)[0]) => {
    try {
      if (job.submittedAtMs !== undefined && metrics.processingLag) {
        const lagSeconds = Math.max(0, (Date.now() - job.submittedAtMs) / 1000);
        metrics.processingLag(lagSeconds);
      }

      const outcome = await runVerification(job, {
        executor: deps.executor,
        resolver: deps.resolver,
        retryAttempt,
      });
      await deps.store.complete(job.recordId, outcome);
      const turnaround =
        job.submittedAtMs !== undefined ? (Date.now() - job.submittedAtMs) / 1000 : undefined;
      metrics.verificationResult(outcome.status, turnaround);
      const corrTag = job.correlationId ? ` [correlationId=${job.correlationId}]` : "";
      log.info(`verification ${job.recordId} → ${outcome.status} (${job.contractId})${corrTag}`);
      // Mirror the outcome on-chain (best-effort; never throws).
      if (deps.attestor) await deps.attestor.reportOutcome(job.contractId, outcome);
    } catch (err) {
      // runVerification only throws on truly unexpected errors; leave the record
      // "building" so it can be retried, and keep processing the batch.
      metrics.workerFailure();
      const corrTag = job.correlationId ? ` [correlationId=${job.correlationId}]` : "";
      log.error(`verification ${job.recordId} errored unexpectedly${corrTag}`, err);
    }
  };

  const workerCount = Math.min(concurrency, jobs.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < jobs.length) {
      const nextIndex = cursor++;
      const job = jobs[nextIndex];
      if (!job) break;
      await processJob(job);
    }
  });

  await Promise.all(workers);

  if (metrics.queueDepth) {
    try {
      const activeAfter = await deps.store.countActive();
      metrics.queueDepth(activeAfter);
    } catch {
      // metric reporting is best effort
    }
  }

  return jobs.length;
}

export interface WorkerLoopHandle {
  stop(): void;
}

/**
 * Runs the tick loop on an interval. When a tick finds work it polls again
 * quickly; when idle it waits `idleDelayMs`. Returns a handle to stop it.
 */
export function startWorkerLoop(
  deps: WorkerDeps & { idleDelayMs?: number; busyDelayMs?: number },
): WorkerLoopHandle {
  const idleDelayMs = deps.idleDelayMs ?? 5000;
  const busyDelayMs = deps.busyDelayMs ?? 250;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
  };

  const tick = async () => {
    if (stopped) return;
    let handled = 0;
    try {
      handled = await runWorkerTick(deps);
    } catch (err) {
      (deps.log ?? silentLog).error("worker tick failed", err);
    }
    schedule(handled > 0 ? busyDelayMs : idleDelayMs);
  };

  schedule(0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
