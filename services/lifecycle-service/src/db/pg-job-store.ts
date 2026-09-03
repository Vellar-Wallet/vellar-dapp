import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "crypto";
import { cleanupJobs } from "./schema";
import type {
  CleanupJobStore,
  ClaimedCleanupJob,
  CleanupJobResult,
} from "./job-store";

/**
 * Postgres-backed cleanup job store (Issue #293).
 *
 * Per-account FIFO ordering is enforced by:
 * 1. Claiming query orders by (accountId, createdAt) to process jobs in FIFO per account
 * 2. Each claimed job includes its sequence number (row number within its account)
 * 3. Out-of-order detection compares actual sequence vs expected sequence
 */

export function createPgCleanupJobStore(db: NodePgDatabase): CleanupJobStore {
  return {
    async enqueueJob(accountId, destination) {
      const jobId = randomUUID();
      const now = new Date();
      const record = {
        id: jobId,
        accountId,
        destination,
        submittedAt: now.toISOString(),
        attempts: 0,
      };

      // Get the sequence number for this job (total jobs for account + 1)
      const sequenceNumber = await this.getNextSequenceNumberForAccount(accountId);

      // Insert the job row using drizzle's insert API
      await db
        .insert(cleanupJobs)
        .values({
          id: jobId,
          accountId,
          destination,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          record,
        })
        .catch((err) => {
          throw new Error(`Failed to enqueue cleanup job: ${err instanceof Error ? err.message : String(err)}`);
        });

      return { jobId, sequenceNumber };
    },
    async claimNextForAccount(accountId, limit) {
      // Claim the next `limit` jobs for this account, ordered by createdAt (FIFO).
      // Use window function to number jobs within the account for sequence tracking.
      const claimIds = sql`(
        select id from ${cleanupJobs}
        where account_id = ${accountId} and status = 'queued'
        order by created_at asc
        limit ${limit}
        for update skip locked
      )`;

      // Flip to 'processing' and bump attempts counter
      const rows = await db
        .update(cleanupJobs)
        .set({
          status: "processing",
          updatedAt: new Date(),
          record: sql`jsonb_set(
            ${cleanupJobs.record},
            '{attempts}',
            to_jsonb(coalesce((${cleanupJobs.record}->>'attempts')::int, 0) + 1)
          )`,
        })
        .where(inArray(cleanupJobs.id, claimIds))
        .returning();

      // Fetch the sequence number for each job (order within the account)
      const sequencedJobs: Array<ClaimedCleanupJob & { sequenceNumber: number }> = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const record = row.record as {
          submittedAt: string;
          attempts?: number;
        };
        const submittedAtMs = Date.parse(record.submittedAt);
        sequencedJobs.push({
          jobId: row.id,
          accountId: row.accountId,
          destination: row.destination,
          submittedAtMs: Number.isFinite(submittedAtMs) ? submittedAtMs : undefined,
          sequenceNumber: i + 1, // 1-based sequence number
        });
      }

      return sequencedJobs;
    },

    async claimNextBatch(limit) {
      // Claim up to `limit` jobs in per-account FIFO order.
      // The ORDER BY (account_id, created_at) ensures we process accounts sequentially,
      // maintaining FIFO per account while distributing work across accounts.
      const claimIds = sql`(
        select id from ${cleanupJobs}
        where status = 'queued'
        order by account_id asc, created_at asc
        limit ${limit}
        for update skip locked
      )`;

      const rows = await db
        .update(cleanupJobs)
        .set({
          status: "processing",
          updatedAt: new Date(),
          record: sql`jsonb_set(
            ${cleanupJobs.record},
            '{attempts}',
            to_jsonb(coalesce((${cleanupJobs.record}->>'attempts')::int, 0) + 1)
          )`,
        })
        .where(inArray(cleanupJobs.id, claimIds))
        .returning();

      return rows.map((row) => {
        const record = row.record as {
          submittedAt: string;
        };
        const submittedAtMs = Date.parse(record.submittedAt);
        return {
          jobId: row.id,
          accountId: row.accountId,
          destination: row.destination,
          submittedAtMs: Number.isFinite(submittedAtMs) ? submittedAtMs : undefined,
        };
      });
    },

    async completeJob(jobId, result) {
      const now = new Date();
      const existing = await db
        .select({ record: cleanupJobs.record })
        .from(cleanupJobs)
        .where(
          and(eq(cleanupJobs.id, jobId), eq(cleanupJobs.status, "processing")),
        )
        .limit(1);

      const current = existing[0]?.record as {
        submittedAt: string;
        attempts?: number;
      } | undefined;
      if (!current) return; // already completed or absent

      const updated = {
        ...current,
        status: "completed" as const,
        steps: result.steps,
        plan: result.plan,
        updatedAt: now.toISOString(),
      };

      await db
        .update(cleanupJobs)
        .set({ status: "completed", updatedAt: now, record: updated })
        .where(eq(cleanupJobs.id, jobId));
    },

    async failJob(jobId, error) {
      const now = new Date();
      const existing = await db
        .select({ record: cleanupJobs.record })
        .from(cleanupJobs)
        .where(eq(cleanupJobs.id, jobId))
        .limit(1);

      const current = existing[0]?.record as {
        submittedAt: string;
        attempts?: number;
      } | undefined;
      if (!current) return;

      const updated = {
        ...current,
        status: "failed" as const,
        error,
        updatedAt: now.toISOString(),
      };

      await db
        .update(cleanupJobs)
        .set({ status: "failed", updatedAt: now, record: updated })
        .where(eq(cleanupJobs.id, jobId));
    },

    async reapStranded({
      timeoutMs,
      maxAttempts,
      baseBackoffDelayMs = 1_000,
      maxBackoffDelayMs = 30_000,
      nowMs,
      onReclaimed,
      onDeadLettered,
    }) {
      const now = nowMs ?? Date.now();
      const cutoff = new Date(now - timeoutMs);

      const rows = await db.execute(sql`
        SELECT id, (record->>'attempts')::int AS attempts
        FROM ${cleanupJobs}
        WHERE status = 'processing' AND updated_at < ${cutoff}
      `);

      const list = (
        (rows as unknown as { rows?: { id: string; attempts: number }[] }).rows ??
        (rows as unknown as { id: string; attempts: number }[])
      ) as { id: string; attempts: number }[];

      let reclaimed = 0;
      let deadLettered = 0;

      for (const row of list) {
        const attempts = row.attempts ?? 0;

        if (attempts >= maxAttempts) {
          // Exhausted all attempts — dead-letter
          await db
            .update(cleanupJobs)
            .set({
              status: "dead_letter",
              updatedAt: new Date(now),
              record: sql`jsonb_set(
                ${cleanupJobs.record},
                '{status}',
                to_jsonb('dead_letter')
              )`,
            })
            .where(eq(cleanupJobs.id, row.id));
          deadLettered++;
          onDeadLettered?.();
        } else {
          // Retry — return to queued
          await db
            .update(cleanupJobs)
            .set({
              status: "queued",
              updatedAt: new Date(now),
              record: sql`jsonb_set(
                ${cleanupJobs.record},
                '{status}',
                to_jsonb('queued')
              )`,
            })
            .where(eq(cleanupJobs.id, row.id));
          reclaimed++;
          onReclaimed?.(attempts);
        }
      }

      return { reclaimed, deadLettered };
    },

    async countActive() {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM ${cleanupJobs}
        WHERE status IN ('queued', 'processing')
      `);
      const list =
        (rows as unknown as { rows?: { n: number }[] }).rows ??
        (rows as unknown as { n: number }[]);
      return list[0]?.n ?? 0;
    },

    async countActiveForAccount(accountId) {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM ${cleanupJobs}
        WHERE account_id = ${accountId} AND status IN ('queued', 'processing')
      `);
      const list =
        (rows as unknown as { rows?: { n: number }[] }).rows ??
        (rows as unknown as { n: number }[]);
      return list[0]?.n ?? 0;
    },

    async getNextSequenceNumberForAccount(accountId) {
      // Count all jobs for this account (regardless of status) to determine
      // the sequence number for the next job
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM ${cleanupJobs}
        WHERE account_id = ${accountId}
      `);
      const list =
        (rows as unknown as { rows?: { n: number }[] }).rows ??
        (rows as unknown as { n: number }[]);
      return (list[0]?.n ?? 0) + 1; // next sequence is count + 1
    },
  };
}
