import type { VerificationStatus } from "@vellar/types";
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
  statusDetail?: string;
  /** When the record reached a terminal state — orders "latest per contract". */
  completedAtMs?: number;
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
