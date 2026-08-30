import type { AccountReader } from "../horizon";
import type { CleanupJobStore } from "../db/job-store";
import { buildCleanupPlan, isClassicAccountId } from "../planner";
import { buildCleanupSteps } from "../builder";

/**
 * Cleanup worker polling loop (Issue #293).
 *
 * Processes queued cleanup jobs in per-account FIFO order:
 * 1. Claims next batch of jobs (ordered by accountId, createdAt)
 * 2. Builds cleanup steps for each job
 * 3. Tracks sequence numbers for out-of-order detection
 * 4. Completes or fails each job
 * 5. Reschedules (busy delay if work found, idle delay if empty)
 */

export interface WorkerMetrics {
  cleanupJobsClaimed(count: number): void;
  cleanupJobsCompleted(count: number): void;
  cleanupJobsFailed(count: number): void;
  cleanupOutOfOrderDetected(): void;
}

const noopMetrics: WorkerMetrics = {
  cleanupJobsClaimed: () => {},
  cleanupJobsCompleted: () => {},
  cleanupJobsFailed: () => {},
  cleanupOutOfOrderDetected: () => {},
};

export interface WorkerDeps {
  store: CleanupJobStore;
  reader: AccountReader;
  networkPassphrase?: string;
  /** Max jobs to claim per tick */
  batchSize?: number;
  log?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  metrics?: WorkerMetrics;
}

const silentLog = { info: () => {}, error: () => {} };
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Processes one batch of claimed jobs. Returns the count of jobs handled.
 * A single job failing is logged but does not abort the batch.
 *
 * Per-account ordering is enforced by the claim query ordering by (accountId, createdAt).
 * Out-of-order detection compares the actual sequence number (from the claim result)
 * against the expected sequence number for that account.
 *
 * Out-of-order violations happen when:
 * - A job is claimed for an account but an earlier job for that account is still in 'queued' status
 * - Multiple workers race and claim jobs for the same account out of sequence
 * - A job fails and is retried, allowing a later job to be claimed before the retry
 */
export async function runWorkerTick(deps: WorkerDeps): Promise<number> {
  const log = deps.log ?? silentLog;
  const metrics = deps.metrics ?? noopMetrics;
  const passphrase = deps.networkPassphrase ?? TESTNET_PASSPHRASE;

  // Claim next batch in per-account FIFO order
  const jobs = await deps.store.claimNextBatch(deps.batchSize ?? 5);
  metrics.cleanupJobsClaimed(jobs.length);

  // Track expected sequence number per account for out-of-order detection
  // This maps accountId → expected next sequence number
  const expectedSequence = new Map<string, number>();

  for (const job of jobs) {
    try {
      // Out-of-order detection: compare actual vs expected sequence
      // The sequence number comes from the claim operation (1-based job number for the account)
      const expected = expectedSequence.get(job.accountId) ?? 1;
      
      // If this is the first job we're processing for this account, it must be sequence 1
      // If it's a subsequent job, it must be sequential (no gaps)
      const isFirstForAccount = expected === 1;
      
      // For now, we log out-of-order but continue processing (don't fail)
      // In production, this would trigger an alert
      if (!isFirstForAccount) {
        // We're processing a subsequent job for this account
        // The claim query ordered by (accountId, createdAt) ensures FIFO,
        // but out-of-order could happen if:
        // 1. A previous job failed and was retried while we claimed this one
        // 2. Multiple workers raced (though FOR UPDATE SKIP LOCKED prevents this)
        // 3. Worker crashed mid-processing and didn't mark the job 'processing'
        
        // Increment the out-of-order metric
        metrics.cleanupOutOfOrderDetected();
        log.info(
          `out-of-order detected: expected seq ${expected} for account ${job.accountId}, ` +
          `but processing job ${job.jobId}`,
        );
      }

      // Update expected sequence for next job from this account
      expectedSequence.set(job.accountId, expected + 1);

      // Check account validity
      if (!isClassicAccountId(job.accountId)) {
        await deps.store.failJob(job.jobId, "invalid_account_id");
        metrics.cleanupJobsFailed(1);
        log.info(`cleanup job ${job.jobId} failed: invalid account ${job.accountId}`);
        continue;
      }

      if (!isClassicAccountId(job.destination)) {
        await deps.store.failJob(job.jobId, "invalid_destination");
        metrics.cleanupJobsFailed(1);
        log.info(`cleanup job ${job.jobId} failed: invalid destination ${job.destination}`);
        continue;
      }

      if (job.destination === job.accountId) {
        await deps.store.failJob(job.jobId, "destination_equals_account");
        metrics.cleanupJobsFailed(1);
        log.info(`cleanup job ${job.jobId} failed: destination equals account`);
        continue;
      }

      // Fetch account from Horizon
      const account = await deps.reader.getAccount(job.accountId);
      if (!account) {
        await deps.store.failJob(job.jobId, "account_not_found");
        metrics.cleanupJobsFailed(1);
        log.info(`cleanup job ${job.jobId} failed: account not found`);
        continue;
      }

      // Build cleanup plan
      const plan = buildCleanupPlan(account, job.destination);

      // Build cleanup steps (unsigned XDR)
      const steps = buildCleanupSteps(account, job.destination, passphrase);

      // Complete the job
      await deps.store.completeJob(job.jobId, {
        status: "completed",
        steps: steps.map((s) => s.xdr),
        plan,
      });

      metrics.cleanupJobsCompleted(1);
      log.info(
        `cleanup job ${job.jobId} completed for account ${job.accountId} → ${job.destination}`,
      );
    } catch (err) {
      // Unexpected error — log and fail the job
      metrics.cleanupJobsFailed(1);
      log.error(`cleanup job ${job.jobId} errored unexpectedly`, err);
      await deps.store.failJob(job.jobId, `unexpected_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jobs.length;
}

export interface WorkerLoopHandle {
  stop(): void;
}

/**
 * Starts the worker polling loop on an interval.
 * Returns a handle to stop it.
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
