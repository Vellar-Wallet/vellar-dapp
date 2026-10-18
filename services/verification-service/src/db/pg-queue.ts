import type { BuildJob, BuildJobQueue, VerificationRepository } from "../server";

/**
 * Default visibility timeout (15 minutes) after which a claimed ("building")
 * job whose worker crashed or stalled before completion becomes claimable again.
 */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 15 * 60 * 1000;

export interface ClaimedBuildJob {
  job: BuildJob;
  workerId: string;
  claimedAtMs: number;
  visibleAfterMs: number;
  attempts: number;
}

export interface QueuedJobState {
  job: BuildJob;
  status: "submitted" | "building" | "verified" | "failed";
  claimedBy?: string;
  claimedAtMs?: number;
  visibleAfterMs?: number;
  attempts: number;
}

export interface PgBuildJobQueueOptions {
  /**
   * Visibility timeout in milliseconds after which a claimed-but-not-completed
   * job becomes claimable again (#535). Defaults to 15 minutes.
   */
  visibilityTimeoutMs?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Optional repository to synchronize status transitions (`submitted` -> `building` -> `verified`/`failed`). */
  records?: VerificationRepository;
}

export interface PgBuildJobQueue extends BuildJobQueue {
  readonly visibilityTimeoutMs: number;
  /**
   * Claims the next available job (either newly `submitted` or a `building` job
   * whose visibility timeout has expired). Ensures a job is never claimed twice
   * simultaneously while within its active visibility window.
   */
  claimNext(workerId?: string): Promise<ClaimedBuildJob | undefined>;
  /**
   * Marks a claimed job as completed (`verified` or `failed`) so it is never
   * reclaimed after its visibility window. Returns `false` if the job is unknown
   * or if its lease was already taken over by another worker.
   */
  complete(
    recordId: string,
    terminalStatus?: "verified" | "failed",
    workerId?: string,
  ): Promise<boolean>;
  /**
   * Sweeps in-flight jobs whose visibility timeout has expired and returns them
   * to the `submitted` state. Returns the count of reclaimed jobs.
   */
  reclaimExpired(): Promise<number>;
  /** Inspects the current queue state for a given `recordId`. */
  getJobState(recordId: string): QueuedJobState | undefined;
}

// Over Postgres, the verification_records row IS the job: verification-service
// inserts it with status="submitted", and worker-service polls for and claims
// submitted rows (see worker-service pg-job-store). When claimed via this queue
// coordinator, a visibility timeout lease (`visibleAfterMs`) ensures that a
// worker crash mid-build does not strand the job forever while preventing two
// healthy workers from claiming the same job concurrently (#535).
export function createPgBuildJobQueue(options: PgBuildJobQueueOptions = {}): PgBuildJobQueue {
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  if (!Number.isFinite(visibilityTimeoutMs) || visibilityTimeoutMs <= 0) {
    throw new Error(
      `visibilityTimeoutMs must be a positive number of milliseconds, got ${visibilityTimeoutMs}`,
    );
  }
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, QueuedJobState>();

  async function syncRecordStatus(
    recordId: string,
    status: "submitted" | "building" | "verified" | "failed",
    timestampMs: number,
  ): Promise<void> {
    if (!options.records) return;
    const existing = await options.records.find(recordId);
    if (!existing) return;
    await options.records.update({
      ...existing,
      status,
      updatedAt: new Date(timestampMs).toISOString(),
    });
  }

  async function reclaimExpiredAt(nowMs: number): Promise<number> {
    let reclaimed = 0;
    for (const entry of entries.values()) {
      if (
        entry.status === "building" &&
        entry.visibleAfterMs !== undefined &&
        nowMs >= entry.visibleAfterMs
      ) {
        entry.status = "submitted";
        entry.claimedBy = undefined;
        entry.claimedAtMs = undefined;
        entry.visibleAfterMs = undefined;
        reclaimed += 1;
        await syncRecordStatus(entry.job.recordId, "submitted", nowMs);
      }
    }
    return reclaimed;
  }

  return {
    visibilityTimeoutMs,

    async enqueue(job: BuildJob): Promise<void> {
      const existing = entries.get(job.recordId);
      if (existing && (existing.status === "building" || existing.status === "verified")) {
        return;
      }
      entries.set(job.recordId, {
        job,
        status: "submitted",
        attempts: existing?.attempts ?? 0,
      });
    },

    async claimNext(workerId = "worker-default"): Promise<ClaimedBuildJob | undefined> {
      const nowMs = now();
      await reclaimExpiredAt(nowMs);

      for (const entry of entries.values()) {
        if (entry.status !== "submitted") {
          continue;
        }
        entry.status = "building";
        entry.claimedBy = workerId;
        entry.claimedAtMs = nowMs;
        entry.visibleAfterMs = nowMs + visibilityTimeoutMs;
        entry.attempts += 1;

        await syncRecordStatus(entry.job.recordId, "building", nowMs);

        return {
          job: entry.job,
          workerId,
          claimedAtMs: nowMs,
          visibleAfterMs: entry.visibleAfterMs,
          attempts: entry.attempts,
        };
      }

      return undefined;
    },

    async complete(
      recordId: string,
      terminalStatus: "verified" | "failed" = "verified",
      workerId?: string,
    ): Promise<boolean> {
      const entry = entries.get(recordId);
      if (!entry) return false;
      if (entry.status === "verified" || entry.status === "failed") {
        return false;
      }
      if (workerId !== undefined && entry.claimedBy !== undefined && entry.claimedBy !== workerId) {
        return false;
      }

      const nowMs = now();
      entry.status = terminalStatus;
      entry.visibleAfterMs = undefined;
      await syncRecordStatus(recordId, terminalStatus, nowMs);
      return true;
    },

    async reclaimExpired(): Promise<number> {
      return reclaimExpiredAt(now());
    },

    getJobState(recordId: string): QueuedJobState | undefined {
      const entry = entries.get(recordId);
      return entry ? { ...entry } : undefined;
    },
  };
}
