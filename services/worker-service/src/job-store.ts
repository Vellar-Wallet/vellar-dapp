import type { VerificationStatus } from "@vela/types";
import type { VerificationJobInput } from "./verify";

// The worker's view of the shared verification store. verification-service
// writes "submitted" records; the worker claims them (submitted → building),
// runs the pipeline, and completes them (building → verified/failed). Keeping
// this a narrow seam means the loop is testable with an in-memory store and
// backed by the same Postgres rows in production (a claim is an atomic
// UPDATE ... WHERE status='submitted' so two workers never double-build a job).

export interface ClaimedJob extends VerificationJobInput {
  recordId: string;
  /** When the record was first submitted (epoch ms) — for turnaround timing.
   * Optional so stores that don't track it still satisfy the contract. */
  submittedAtMs?: number;
}

export interface VerificationJobStore {
  /** Atomically claim up to `limit` submitted jobs, flipping them to "building".
   * Returns the claimed jobs (empty when the queue is idle). */
  claimSubmitted(limit: number): Promise<ClaimedJob[]>;
  /** Record a terminal outcome for a claimed job. */
  complete(
    recordId: string,
    result: {
      status: Extract<VerificationStatus, "verified" | "failed">;
      outputHash?: string;
      deployedHash?: string;
      log: string;
    },
  ): Promise<void>;
}
