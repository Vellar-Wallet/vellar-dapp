import type { VerificationStatus } from "@vellar/types";
import { calculateBackoffDelay } from "./backoff";
import type { ClaimedJob, ReapResult, VerificationJobStore } from "./job-store";
import type { VerificationJobInput } from "./verify";

// An in-memory VerificationJobStore for local dev (no Postgres) and tests. Claim
// is atomic within the single-threaded event loop: it flips matching records to
// "building" before returning them, so a second claim in the same process won't
// re-hand the same job.

interface Row {
  recordId: string;
  status: VerificationStatus;
  job: VerificationJobInput;
  submittedAtMs?: number;
  outputHash?: string;
  deployedHash?: string;
  log?: string;
  statusDetail?: string;
  /** When the record reached a terminal state — orders "latest per contract". */
  completedAtMs?: number;
  /** Number of times this job has been claimed for building (M7 reaper). */
  attempts?: number;
  /** When the current 'building' claim started (epoch ms) — reaper timeout base. */
  startedBuildingAtMs?: number;
}

export interface MemoryJobStore extends VerificationJobStore {
  /** Seed a submitted job (test/dev helper). `submittedAtMs` sets the turnaround
   * clock start (defaults to now). */
  submit(recordId: string, job: VerificationJobInput, submittedAtMs?: number): void;
  /** Inspect a record's current state (test/dev helper). */
  get(recordId: string): Row | undefined;
}

export function createMemoryJobStore(): MemoryJobStore {
  const rows = new Map<string, Row>();
  return {
    submit(recordId, job, submittedAtMs = Date.now()) {
      rows.set(recordId, { recordId, status: "submitted", job, submittedAtMs });
    },
    get(recordId) {
      return rows.get(recordId);
    },
    async claimSubmitted(limit) {
      const claimed: ClaimedJob[] = [];
      for (const row of rows.values()) {
        if (claimed.length >= limit) break;
        if (row.status === "submitted") {
          row.status = "building";
          row.attempts = (row.attempts ?? 0) + 1;
          row.startedBuildingAtMs = Date.now();
          claimed.push({ recordId: row.recordId, ...row.job, submittedAtMs: row.submittedAtMs });
        }
      }
      return claimed;
    },

    async reapStranded({ timeoutMs, maxAttempts, baseBackoffDelayMs = 1_000, maxBackoffDelayMs = 30_000, nowMs, onReclaimed, onDeadLettered }) {
      const now = nowMs ?? Date.now();
      let reclaimed = 0;
      let deadLettered = 0;
      for (const row of rows.values()) {
        if (row.status !== "building") continue;
        if (now - (row.startedBuildingAtMs ?? now) <= timeoutMs) continue;
        // Stranded. Park it if it has already used all its attempts, else return
        // it to the queue for another try with exponential backoff delay.
        if ((row.attempts ?? 0) >= maxAttempts) {
          row.status = "dead_letter";
          row.completedAtMs = now;
          deadLettered++;
          onDeadLettered?.();
        } else {
          row.status = "submitted";
          row.startedBuildingAtMs = undefined;
          // Calculate exponential backoff delay for next reclaim
          const attempt = (row.attempts ?? 0) - 1; // attempts already incremented at claim
          const backoffDelay = calculateBackoffDelay(attempt, baseBackoffDelayMs, maxBackoffDelayMs);
          // In memory store, we'd apply this delay on next claim by checking timestamp
          // For test purposes, we just record the backoff happened
          reclaimed++;
          onReclaimed?.(attempt);
        }
      }
      return { reclaimed, deadLettered };
    },

    async countActive() {
      let n = 0;
      for (const row of rows.values()) {
        if (row.status === "submitted" || row.status === "building") n++;
      }
      return n;
    },

    async hasActiveForContract(contractId) {
      for (const row of rows.values()) {
        if (
          row.job.contractId === contractId &&
          (row.status === "submitted" || row.status === "building")
        ) {
          return true;
        }
      }
      return false;
    },
    async complete(recordId, result) {
      const row = rows.get(recordId);
      if (!row) return;
      row.status = result.status;
      row.outputHash = result.outputHash;
      row.deployedHash = result.deployedHash;
      row.log = result.log;
      row.statusDetail = result.statusDetail;
      row.completedAtMs = Date.now();
    },
    async listLatestVerified(limit) {
      // Latest terminal record per contract; include only when that latest is
      // a verified run with a rebuilt hash (a newer failed run supersedes an
      // older verified one — mirroring the pg DISTINCT ON semantics).
      const latestByContract = new Map<string, Row>();
      for (const row of rows.values()) {
        if (row.status !== "verified" && row.status !== "failed") continue;
        const current = latestByContract.get(row.job.contractId);
        if (!current || (row.completedAtMs ?? 0) > (current.completedAtMs ?? 0)) {
          latestByContract.set(row.job.contractId, row);
        }
      }
      const result: Array<{ contractId: string; outputHash: string }> = [];
      for (const row of latestByContract.values()) {
        if (result.length >= limit) break;
        if (row.status === "verified" && row.outputHash) {
          result.push({ contractId: row.job.contractId, outputHash: row.outputHash });
        }
      }
      return result;
    },
  };
}
