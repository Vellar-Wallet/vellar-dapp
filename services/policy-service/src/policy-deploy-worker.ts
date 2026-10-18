/**
 * Policy deployment worker: claims failed deployment jobs, retries with backoff,
 * and moves jobs to DLQ when retry count exceeds maxRetries.
 *
 * Key responsibility:
 * - Atomically increment retry_count on failure
 * - Move to DLQ when retry_count > MAX_RETRIES
 * - Record audit events and metrics
 * - Handle concurrent failures safely (DB transaction + row-level locks)
 */

import {
  computeBackoffDelay,
  retryWithJitter,
  type JitterMode,
  type RetryOptions,
} from "@vellar/service-kit";
import { summarizeError, type DLQStore, type DLQRecord } from "./dlq-store";
import type { PolicyDeployer } from "./deploy";
import type { PolicyRepository, PolicyRecord } from "./server";

export const MAX_RETRIES = 5; // Configurable per job type

export interface DeployJob {
  id: string; // Job id (UUID)
  policy_id: string; // Policy to deploy
  wallet: string; // Smart account address
  network: "testnet" | "mainnet";
  status: "pending" | "in_progress" | "completed" | "failed" | "dead";
  retry_count: number;
  next_retry_delay_ms?: number;
  last_error?: string;
  last_failed_at?: string;
  first_failed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DeployJobStore {
  /**
   * Claim a pending job for processing (atomically mark as in_progress).
   * Returns undefined if no jobs available.
   */
  claim(): Promise<DeployJob | undefined>;

  /**
   * Mark job as completed with the deployed contract id.
   */
  markCompleted(jobId: string, contractId: string, txHash: string): Promise<void>;

  /**
   * Handle job failure: increment retry_count or move to DLQ if exceeded.
   * This must be atomic to prevent races under concurrent workers.
   */
  handleFailure(
    jobId: string,
    error: unknown,
    dlqStore: DLQStore,
    dlqMetrics?: DLQMetrics,
  ): Promise<void>;

  /**
   * Get current job state (for testing and diagnostics).
   */
  get(jobId: string): Promise<DeployJob | undefined>;
}

export interface DLQMetrics {
  dlq_enqueue_total: { inc(labels: { job_type: string }): void };
  dlq_depth_gauge: { set(value: number): void };
  /** Incremented by the admin requeue route. */
  dlq_requeue_total?: { inc(labels: { job_type: string }): void };
}

export class InMemoryDeployJobStore implements DeployJobStore {
  private jobs = new Map<string, DeployJob>();
  private nextJobId = 0;

  async claim(): Promise<DeployJob | undefined> {
    for (const job of this.jobs.values()) {
      if (job.status === "pending") {
        job.status = "in_progress";
        job.updated_at = new Date().toISOString();
        return job;
      }
    }
    return undefined;
  }

  async markCompleted(jobId: string, contractId: string, txHash: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = "completed";
    job.updated_at = new Date().toISOString();
  }

  async handleFailure(
    jobId: string,
    error: unknown,
    dlqStore: DLQStore,
    dlqMetrics?: DLQMetrics,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const now = new Date().toISOString();
    job.retry_count += 1;
    job.last_error = summarizeError(error);
    job.last_failed_at = now;
    if (!job.first_failed_at) job.first_failed_at = now;
    job.updated_at = now;

    if (job.retry_count > MAX_RETRIES) {
      // Move to DLQ
      job.status = "dead";
      const dlqRecord = await dlqStore.insert({
        original_job_id: jobId,
        policy_id: job.policy_id,
        job_type: "policy_deploy",
        payload: {
          wallet: job.wallet,
          network: job.network,
          policy_id: job.policy_id,
        },
        last_error: job.last_error,
        failure_count: job.retry_count,
        first_failed_at: job.first_failed_at,
        last_failed_at: job.last_failed_at,
      });

      if (dlqMetrics) {
        dlqMetrics.dlq_enqueue_total.inc({ job_type: "policy_deploy" });
        dlqMetrics.dlq_depth_gauge.set(await dlqStore.depth());
      }

      // Record audit event
      await dlqStore.recordAudit({
        dlq_id: dlqRecord.id,
        event_type: "dlq_move",
        metadata: {
          original_job_id: jobId,
          reason: job.last_error,
          retry_count: job.retry_count,
        },
      });
    } else {
      // Reset to pending and schedule next retry with full jitter via @vellar/service-kit
      job.status = "pending";
      job.next_retry_delay_ms = computeBackoffWithJitter(job.retry_count);
    }
  }

  async get(jobId: string): Promise<DeployJob | undefined> {
    return this.jobs.get(jobId);
  }

  // Helper for testing
  addJob(job: DeployJob): void {
    this.jobs.set(job.id, job);
  }

  // Helper for testing
  getAllJobs(): DeployJob[] {
    return Array.from(this.jobs.values());
  }
}

/**
 * Compute exponential backoff delay in milliseconds via `@vellar/service-kit`.
 * Capped at 1 hour to avoid runaway delays.
 */
export function computeBackoff(
  retryCount: number,
  options: { jitter?: JitterMode | boolean; random?: () => number } = {},
): number {
  return computeBackoffDelay(Math.max(0, retryCount - 1), {
    baseMs: 1_000,
    maxMs: 60 * 60 * 1_000, // 1 hour
    jitter: options.jitter ?? "none",
    random: options.random,
  });
}

/**
 * Compute jittered exponential backoff delay in milliseconds via `@vellar/service-kit`
 * so concurrent deployment workers do not retry in lockstep after an RPC outage.
 */
export function computeBackoffWithJitter(
  retryCount: number,
  options: { jitter?: JitterMode | boolean; random?: () => number } = {},
): number {
  return computeBackoff(retryCount, {
    ...options,
    jitter: options.jitter ?? "full",
  });
}

/**
 * Worker function to process one deployment job.
 * Returns true if a job was processed, false if no jobs available.
 */
export async function processDeploymentJob(
  jobStore: DeployJobStore,
  policyRepo: PolicyRepository,
  deployer: PolicyDeployer,
  dlqStore: DLQStore,
  dlqMetrics?: DLQMetrics,
  retryOptions?: RetryOptions,
): Promise<boolean> {
  const job = await jobStore.claim();
  if (!job) return false;

  try {
    const policy = await policyRepo.find(job.policy_id);
    if (!policy) {
      throw new Error(`Policy not found: ${job.policy_id}`);
    }

    const enforcement = policy.manifest.enforcement;
    if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
      throw new Error(`Policy is not contract-enforced: ${job.policy_id}`);
    }
    const constructorArgs = enforcement.constructorArgs;
    const result = await retryWithJitter(
      () =>
        deployer.deployInstance({
          wallet: job.wallet,
          constructorArgs,
        }),
      {
        maxAttempts: retryOptions?.maxAttempts ?? 1,
        baseMs: retryOptions?.baseMs ?? retryOptions?.baseDelayMs ?? 1_000,
        maxMs: retryOptions?.maxMs ?? retryOptions?.maxDelayMs ?? 30_000,
        jitter: retryOptions?.jitter ?? "full",
        isRetryable: retryOptions?.isRetryable,
        sleep: retryOptions?.sleep,
        signal: retryOptions?.signal,
      },
    );

    await jobStore.markCompleted(job.id, result.contractId, result.txHash);
    return true;
  } catch (err) {
    await jobStore.handleFailure(job.id, err, dlqStore, dlqMetrics);
    return true; // Job was processed (even though it failed)
  }
}
