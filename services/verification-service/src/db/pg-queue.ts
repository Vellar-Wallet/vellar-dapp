import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BuildJob, BuildJobQueue } from "../server";
import { verificationRecords } from "./schema";

export interface PgQueueOptions {
  /** Visibility timeout in milliseconds after which a claimed job becomes claimable again. Defaults to 30,000ms. */
  visibilityTimeoutMs?: number;
  /** Maximum number of claim attempts before dead-lettering / permanent failure. Defaults to 3. */
  maxAttempts?: number;
  /** Custom clock provider for deterministic testing. */
  now?: () => number;
}

export interface ClaimedBuildJob {
  recordId: string;
  job: BuildJob;
  attempts: number;
  claimedAt: number;
  claimedBy: string;
}

export interface PgBuildJobQueue extends BuildJobQueue {
  enqueue(job: BuildJob): Promise<void>;
  claim(
    workerId: string,
    options?: { visibilityTimeoutMs?: number; now?: number },
  ): Promise<ClaimedBuildJob | null>;
  complete(recordId: string, workerId?: string): Promise<boolean>;
  fail(recordId: string, error?: string): Promise<void>;
  release(recordId: string): Promise<void>;
  getJob(
    recordId: string,
  ): Promise<{ status: string; attempts: number; claimedBy?: string } | null>;
  reapStranded(nowMs?: number): Promise<number>;
  size(): Promise<number>;
}

interface MemoryJobEntry {
  job: BuildJob;
  status: "submitted" | "building" | "completed" | "failed" | "dead_letter";
  attempts: number;
  claimedAt?: number;
  claimedBy?: string;
  visibilityTimeoutMs: number;
  error?: string;
}

export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Creates a build job queue with visibility timeout support.
 *
 * When a worker claims a job, it enters the 'building' state with a visibility timeout.
 * If the worker completes the job within the timeout window, the job is marked completed.
 * If the worker crashes or fails to complete the job before the timeout expires,
 * the job becomes visible again and can be claimed and retried by another worker.
 *
 * Dual-mode:
 * - With Postgres db: Uses atomic SELECT ... FOR UPDATE SKIP LOCKED and updates with timestamp cutoff.
 * - Without db: Uses an in-memory queue with identical concurrency and timeout semantics.
 */
export function createPgBuildJobQueue(
  db?: NodePgDatabase,
  options: PgQueueOptions = {},
): PgBuildJobQueue {
  const defaultVisibilityTimeout = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const getNow = options.now ?? (() => Date.now());

  if (db) {
    return {
      async enqueue(_job: BuildJob): Promise<void> {
        // With Postgres, the verification_records table row created during submission
        // is the queued job. If not already inserted, nothing more needed.
      },

      async claim(
        workerId: string,
        opts?: { visibilityTimeoutMs?: number; now?: number },
      ): Promise<ClaimedBuildJob | null> {
        const timeout = opts?.visibilityTimeoutMs ?? defaultVisibilityTimeout;
        const currentTimeMs = opts?.now ?? getNow();
        const currentTime = new Date(currentTimeMs);
        const cutoff = new Date(currentTimeMs - timeout);

        const claimIds = sql`(
          SELECT id FROM ${verificationRecords}
          WHERE status = 'submitted'
             OR (status = 'building' AND updated_at < ${cutoff})
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`;

        const rows = await db
          .update(verificationRecords)
          .set({
            status: "building",
            updatedAt: currentTime,
            record: sql`jsonb_set(
              jsonb_set(${verificationRecords.record}, '{attempts}', to_jsonb(coalesce((${verificationRecords.record}->>'attempts')::int, 0) + 1)),
              '{claimedBy}', to_jsonb(${workerId}::text)
            )`,
          })
          .where(inArray(verificationRecords.id, claimIds))
          .returning({ id: verificationRecords.id, record: verificationRecords.record });

        if (rows.length === 0) {
          return null;
        }

        const row = rows[0]!;
        const rec = row.record as any;
        const attempts = typeof rec?.attempts === "number" ? rec.attempts : 1;

        const job: BuildJob = {
          recordId: row.id,
          contractId: rec?.contractId ?? "",
          sourceType: rec?.sourceType ?? "repo",
          repoUrl: rec?.repoUrl,
          commitHash: rec?.commitHash,
          sourceArchiveRef: rec?.sourceArchiveRef,
          toolchainVersion: rec?.toolchainVersion ?? "",
          buildFlags: rec?.buildFlags,
          traceId: rec?.traceId,
          traceParentSpanId: rec?.traceParentSpanId,
        };

        return {
          recordId: row.id,
          job,
          attempts,
          claimedAt: currentTimeMs,
          claimedBy: workerId,
        };
      },

      async complete(recordId: string, workerId?: string): Promise<boolean> {
        const now = new Date(getNow());
        // A claimant that lost the job to a visibility-timeout reclaim must not
        // be able to complete it. Legacy callers that do not identify
        // themselves keep the previous unguarded behavior.
        const ownership =
          workerId === undefined
            ? undefined
            : sql`${verificationRecords.record}->>'claimedBy' = ${workerId}`;
        const result = await db
          .update(verificationRecords)
          .set({
            status: "verified",
            updatedAt: now,
            record: sql`jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('verified'::text))`,
          })
          .where(
            and(
              eq(verificationRecords.id, recordId),
              eq(verificationRecords.status, "building"),
              ownership,
            ),
          )
          .returning({ id: verificationRecords.id });

        return result.length > 0;
      },

      async fail(recordId: string, error?: string): Promise<void> {
        const now = new Date(getNow());
        await db
          .update(verificationRecords)
          .set({
            status: "failed",
            updatedAt: now,
            record: sql`jsonb_set(
              jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('failed'::text)),
              '{error}', to_jsonb(${error ?? "build failed"}::text)
            )`,
          })
          .where(eq(verificationRecords.id, recordId));
      },

      async release(recordId: string): Promise<void> {
        const now = new Date(getNow());
        await db
          .update(verificationRecords)
          .set({
            status: "submitted",
            updatedAt: now,
            record: sql`jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('submitted'::text))`,
          })
          .where(
            and(
              eq(verificationRecords.id, recordId),
              eq(verificationRecords.status, "building"),
            ),
          );
      },

      async getJob(
        recordId: string,
      ): Promise<{ status: string; attempts: number; claimedBy?: string } | null> {
        const rows = await db
          .select({ status: verificationRecords.status, record: verificationRecords.record })
          .from(verificationRecords)
          .where(eq(verificationRecords.id, recordId))
          .limit(1);

        if (rows.length === 0) return null;
        const row = rows[0]!;
        const rec = row.record as any;
        return {
          status: row.status,
          attempts: typeof rec?.attempts === "number" ? rec.attempts : 0,
          claimedBy: rec?.claimedBy,
        };
      },

      async reapStranded(nowMs?: number): Promise<number> {
        const currentTime = nowMs ?? getNow();
        const cutoff = new Date(currentTime - defaultVisibilityTimeout);

        const rows = await db
          .update(verificationRecords)
          .set({
            status: "submitted",
            updatedAt: new Date(currentTime),
            record: sql`jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('submitted'::text))`,
          })
          .where(
            and(
              eq(verificationRecords.status, "building"),
              sql`${verificationRecords.updatedAt} < ${cutoff}`,
            ),
          )
          .returning({ id: verificationRecords.id });

        return rows.length;
      },

      async size(): Promise<number> {
        const rows = await db.execute(sql`
          SELECT count(*)::int AS n FROM ${verificationRecords}
          WHERE status IN ('submitted', 'building')
        `);
        const list = (rows as any).rows ?? rows;
        return list[0]?.n ?? 0;
      },
    };
  }

  // In-memory implementation with full visibility timeout and atomic claiming semantics
  const memoryJobs = new Map<string, MemoryJobEntry>();

  return {
    async enqueue(job: BuildJob): Promise<void> {
      memoryJobs.set(job.recordId, {
        job,
        status: "submitted",
        attempts: 0,
        visibilityTimeoutMs: defaultVisibilityTimeout,
      });
    },

    async claim(
      workerId: string,
      opts?: { visibilityTimeoutMs?: number; now?: number },
    ): Promise<ClaimedBuildJob | null> {
      const now = opts?.now ?? getNow();
      const timeout = opts?.visibilityTimeoutMs ?? defaultVisibilityTimeout;

      for (const [recordId, entry] of memoryJobs.entries()) {
        const isSubmitted = entry.status === "submitted";
        const isStranded =
          entry.status === "building" &&
          entry.claimedAt !== undefined &&
          now - entry.claimedAt >= (entry.visibilityTimeoutMs ?? timeout);

        if (isSubmitted || isStranded) {
          if (entry.attempts >= maxAttempts && isStranded) {
            entry.status = "dead_letter";
            continue;
          }

          // Atomic claim
          entry.status = "building";
          entry.attempts += 1;
          entry.claimedAt = now;
          entry.claimedBy = workerId;
          entry.visibilityTimeoutMs = timeout;

          return {
            recordId,
            job: entry.job,
            attempts: entry.attempts,
            claimedAt: now,
            claimedBy: workerId,
          };
        }
      }

      return null;
    },

    async complete(recordId: string, workerId?: string): Promise<boolean> {
      const entry = memoryJobs.get(recordId);
      if (!entry || entry.status !== "building") {
        return false;
      }
      // Fence a stale claimant: worker 1 may still be running after its
      // visibility timeout let worker 2 reclaim the same job (#794).
      if (workerId !== undefined && entry.claimedBy !== workerId) {
        return false;
      }
      entry.status = "completed";
      return true;
    },

    async fail(recordId: string, error?: string): Promise<void> {
      const entry = memoryJobs.get(recordId);
      if (entry) {
        entry.status = "failed";
        entry.error = error;
      }
    },

    async release(recordId: string): Promise<void> {
      const entry = memoryJobs.get(recordId);
      if (entry && entry.status === "building") {
        entry.status = "submitted";
        entry.claimedBy = undefined;
        entry.claimedAt = undefined;
      }
    },

    async getJob(
      recordId: string,
    ): Promise<{ status: string; attempts: number; claimedBy?: string } | null> {
      const entry = memoryJobs.get(recordId);
      if (!entry) return null;
      return {
        status: entry.status,
        attempts: entry.attempts,
        claimedBy: entry.claimedBy,
      };
    },

    async reapStranded(nowMs?: number): Promise<number> {
      const now = nowMs ?? getNow();
      let reaped = 0;
      for (const entry of memoryJobs.values()) {
        if (
          entry.status === "building" &&
          entry.claimedAt !== undefined &&
          now - entry.claimedAt >= entry.visibilityTimeoutMs
        ) {
          if (entry.attempts >= maxAttempts) {
            entry.status = "dead_letter";
          } else {
            entry.status = "submitted";
            entry.claimedBy = undefined;
            entry.claimedAt = undefined;
          }
          reaped++;
        }
      }
      return reaped;
    },

    async size(): Promise<number> {
      let count = 0;
      for (const entry of memoryJobs.values()) {
        if (entry.status === "submitted" || entry.status === "building") {
          count++;
        }
      }
      return count;
    },
  };
}
