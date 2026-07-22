import type { VerificationStatus } from "@vela/types";
import type { ClaimedJob, VerificationJobStore } from "./job-store";
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
          claimed.push({ recordId: row.recordId, ...row.job, submittedAtMs: row.submittedAtMs });
        }
      }
      return claimed;
    },
    async complete(recordId, result) {
      const row = rows.get(recordId);
      if (!row) return;
      row.status = result.status;
      row.outputHash = result.outputHash;
      row.deployedHash = result.deployedHash;
      row.log = result.log;
    },
  };
}
