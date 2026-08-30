/**
 * Interface for the cleanup job queue store (Issue #293).
 *
 * Implementations of this interface handle job persistence, claiming, and completion.
 * The store enforces per-account FIFO ordering by claiming jobs ordered by
 * (accountId, createdAt), ensuring jobs for the same account are processed sequentially.
 */

export interface ClaimedCleanupJob {
  jobId: string;
  accountId: string;
  destination: string;
  submittedAtMs?: number;
}

export interface CleanupJobResult {
  status: "completed" | "failed";
  steps?: string[]; // Unsigned XDR transaction steps if completed
  plan?: unknown; // Cleanup plan details if completed
  error?: string; // Error message if failed
}

export interface JobStoreMetrics {
  jobsClaimed?(count: number): void;
  jobsCompleted?(count: number): void;
  jobsFailed?(count: number): void;
  outOfOrderDetected?(): void;
}

export interface CleanupJobStore {
  /** Enqueue a new cleanup job. Returns the job ID and initial sequence number. */
  enqueueJob(
    accountId: string,
    destination: string,
  ): Promise<{ jobId: string; sequenceNumber: number }>;

  /** Claim up to `limit` jobs for a single account, ordered by createdAt (FIFO).
   * Returns claimed jobs and their sequence number for out-of-order detection.
   * The sequence number is the 1-based job order for this account. */
  claimNextForAccount(
    accountId: string,
    limit: number,
  ): Promise<Array<ClaimedCleanupJob & { sequenceNumber: number }>>;

  /** Claim up to `limit` jobs across all accounts in per-account FIFO order.
   * Returns jobs in (accountId, createdAt) order to maintain per-account sequencing. */
  claimNextBatch(limit: number): Promise<ClaimedCleanupJob[]>;

  /** Mark a job as completed with its result. */
  completeJob(jobId: string, result: CleanupJobResult): Promise<void>;

  /** Mark a job as failed with an error message. */
  failJob(jobId: string, error: string): Promise<void>;

  /** Reap stranded/timeout jobs and apply backoff logic.
   * Returns count of reclaimed and dead-lettered jobs. */
  reapStranded(options: {
    timeoutMs: number;
    maxAttempts: number;
    baseBackoffDelayMs?: number;
    maxBackoffDelayMs?: number;
    nowMs?: number;
    onReclaimed?: (attemptNumber: number) => void;
    onDeadLettered?: () => void;
  }): Promise<{ reclaimed: number; deadLettered: number }>;

  /** Get count of active jobs (queued + processing). */
  countActive(): Promise<number>;

  /** Get count of active jobs for a specific account. */
  countActiveForAccount(accountId: string): Promise<number>;

  /** Get the expected sequence number (1-based) for the next job for an account. */
  getNextSequenceNumberForAccount(accountId: string): Promise<number>;
}
