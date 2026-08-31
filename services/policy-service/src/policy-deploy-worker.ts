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
      // Reset to pending for retry with backoff
      job.status = "pending";
      // In production, schedule retry with exponential backoff
      // For now, leave it in pending state for the next poll
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
 * Compute exponential backoff delay in milliseconds.
 * Capped at 1 hour to avoid runaway delays.
 */
export function computeBackoff(retryCount: number): number {
  const baseDelayMs = 1000;
  const maxDelayMs = 60 * 60 * 1000; // 1 hour
  const delayMs = baseDelayMs * Math.pow(2, Math.max(0, retryCount - 1));
  return Math.min(delayMs, maxDelayMs);
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
): Promise<boolean> {
  const job = await jobStore.claim();
  if (!job) return false;

  try {
    const policy = await policyRepo.find(job.policy_id);
    if (!policy) {
      throw new Error(`Policy not found: ${job.policy_id}`);
    }

    const result = await deployer.deployInstance({
      wallet: job.wallet,
      constructorArgs: policy.constructorArgs,
    });

    await jobStore.markCompleted(job.id, result.contractId, result.txHash);
    return true;
  } catch (err) {
    await jobStore.handleFailure(job.id, err, dlqStore, dlqMetrics);
    return true; // Job was processed (even though it failed)
  }
}
