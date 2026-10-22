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

import { retryWithJitter } from "@vellar/service-kit";
import { summarizeError, type DLQStore, type DLQRecord } from "./dlq-store";
import type { PolicyDeployer } from "./deploy";
import type { PolicyRepository, PolicyRecord } from "./server";

export const DEFAULT_DLQ_THRESHOLD = 5;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_RETRIES = DEFAULT_DLQ_THRESHOLD; // Configurable per job type

/**
 * Terminal error indicating a permanent failure that cannot succeed upon retry.
 */
export class TerminalDeployError extends Error {
  readonly isTerminal = true;
  constructor(message: string) {
    super(message);
    this.name = "TerminalDeployError";
  }
}

/**
 * Classifies an error as terminal (permanent) vs retryable (transient).
 */
export function isTerminalFailure(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "isTerminal" in error && Boolean((error as any).isTerminal)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const terminalPatterns = [
    /policy not found/i,
    /not contract-enforced/i,
    /invalid template/i,
    /unknown policy type/i,
    /missing constructor args/i,
    /schema version .* does not exist/i,
    /unattributable publisher/i,
    /terminal/i,
  ];
  return terminalPatterns.some((pattern) => pattern.test(message));
}

export interface DeployJob {
  id: string; // Job id (UUID)
  policy_id: string; // Policy to deploy
  wallet: string; // Smart account address
  network: "testnet" | "mainnet";
  status: "pending" | "in_progress" | "completed" | "failed" | "dead";
  retry_count: number;
  max_attempts?: number; // Configurable per-job distinct from DLQ threshold
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
   * Handle job failure: increment retry_count or move to DLQ if exceeded or terminal.
   * This must be atomic to prevent races under concurrent workers.
   */
  handleFailure(
    jobId: string,
    error: unknown,
    dlqStore: DLQStore,
    dlqMetrics?: DLQMetrics,
    options?: { maxAttempts?: number; dlqThreshold?: number },
  ): Promise<void>;

  /**
   * Get current job state (for testing and diagnostics).
   */
  get(jobId: string): Promise<DeployJob | undefined>;

  /**
   * Add a job to the store (for testing or requeue).
   */
  addJob?(job: DeployJob): Promise<void> | void;
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
  maxAttempts?: number;
  dlqThreshold: number;

  constructor(options?: { maxAttempts?: number; dlqThreshold?: number }) {
    this.maxAttempts = options?.maxAttempts;
    this.dlqThreshold = options?.dlqThreshold ?? MAX_RETRIES;
  }

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
    options?: { maxAttempts?: number; dlqThreshold?: number },
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const now = new Date().toISOString();
    job.retry_count += 1;
    job.last_error = summarizeError(error);
    job.last_failed_at = now;
    if (!job.first_failed_at) job.first_failed_at = now;
    job.updated_at = now;

    const isTerminal = isTerminalFailure(error);
    const configuredMaxAttempts = options?.maxAttempts ?? job.max_attempts ?? this.maxAttempts;
    const configuredDlqThreshold = options?.dlqThreshold ?? this.dlqThreshold;

    const exceedsMaxAttempts =
      configuredMaxAttempts !== undefined && job.retry_count >= configuredMaxAttempts;
    const exceedsDlqThreshold = job.retry_count > configuredDlqThreshold;

    if (isTerminal || exceedsMaxAttempts || exceedsDlqThreshold) {
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
          terminal: isTerminal,
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
          terminal: isTerminal,
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
 * Compute exponential backoff delay in milliseconds with full jitter.
 *
 * Delegates to the shared `retryWithJitter` helper in
 * packages/service-kit (issue #549) so the jittered-retry pattern is
 * defined once rather than duplicated across services. Capped at 1 hour
 * to avoid runaway delays.
 */
export function computeBackoff(retryCount: number): number {
  return retryWithJitter(Math.max(0, retryCount - 1), {
    baseDelayMs: 1000,
    maxDelayMs: 60 * 60 * 1000, // 1 hour
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
): Promise<boolean> {
  const job = await jobStore.claim();
  if (!job) return false;

  try {
    const policy = await policyRepo.find(job.policy_id);
    if (!policy) {
      throw new TerminalDeployError(`Policy not found: ${job.policy_id}`);
    }

    const enforcement = policy.manifest.enforcement;
    if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
      throw new TerminalDeployError(`Policy is not contract-enforced: ${job.policy_id}`);
    }
    const result = await deployer.deployInstance({
      wallet: job.wallet,
      constructorArgs: enforcement.constructorArgs,
    });

    await jobStore.markCompleted(job.id, result.contractId, result.txHash);
    return true;
  } catch (err) {
    await jobStore.handleFailure(job.id, err, dlqStore, dlqMetrics);
    return true; // Job was processed (even though it failed)
  }
}
