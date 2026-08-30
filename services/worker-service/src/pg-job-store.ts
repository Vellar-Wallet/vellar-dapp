import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { verificationRecords } from "@vellar/verification-service/db-schema";
import type { VerificationRecordInternal } from "@vellar/verification-service/server";
import { calculateBackoffDelay } from "./backoff";
import type { ClaimedJob, ReapResult, VerificationJobStore } from "./job-store";

// Postgres-backed job store, sharing the verification_records table (and its
// schema) with verification-service — the row IS the job. Claiming is atomic:
// a single UPDATE ... WHERE status='submitted' ... RETURNING flips rows to
// "building" and returns them, so two workers never build the same job (the
// row-level lock the UPDATE takes serializes concurrent claims). This is the
// retryable, horizontally-scalable pipeline idea.md §13 calls for.

export function createPgJobStore(db: NodePgDatabase): VerificationJobStore {
  return {
    async claimSubmitted(limit) {
      // Select-and-claim in one statement. FOR UPDATE SKIP LOCKED lets multiple
      // workers claim disjoint batches without blocking each other.
      const claimIds = sql`(
        select id from ${verificationRecords}
        where status = 'submitted'
        order by created_at asc
        limit ${limit}
        for update skip locked
      )`;
      // Flip to building AND bump the attempts counter in the jsonb (M7): the
      // reaper reads it to decide reclaim vs dead-letter. updatedAt doubles as
      // the "building started" clock the reaper times out against.
      const rows = await db
        .update(verificationRecords)
        .set({
          status: "building",
          updatedAt: new Date(),
          record: sql`jsonb_set(${verificationRecords.record}, '{attempts}', to_jsonb(coalesce((${verificationRecords.record}->>'attempts')::int, 0) + 1))`,
        })
        .where(inArray(verificationRecords.id, claimIds))
        .returning({ id: verificationRecords.id, record: verificationRecords.record });

      return rows.map((row): ClaimedJob => {
        const r = row.record as VerificationRecordInternal;
        const submittedAtMs = Date.parse(r.createdAt);
        return {
          recordId: r.id,
          contractId: r.contractId,
          sourceType: r.sourceType,
          repoUrl: r.repoUrl,
          commitHash: r.commitHash,
          sourceArchiveRef: r.sourceArchiveRef,
          toolchainVersion: r.toolchainVersion,
          buildFlags: r.buildFlags,
          submittedAtMs: Number.isFinite(submittedAtMs) ? submittedAtMs : undefined,
        };
      });
    },

    async complete(recordId, result) {
      const now = new Date();
      // Read-modify-write the jsonb so the stored record stays the single source
      // of truth (its own status/outputHash/log fields must match the columns).
      const existing = await db
        .select({ record: verificationRecords.record })
        .from(verificationRecords)
        .where(
          and(eq(verificationRecords.id, recordId), eq(verificationRecords.status, "building")),
        )
        .limit(1);
      const current = existing[0]?.record as VerificationRecordInternal | undefined;
      if (!current) return; // already completed or absent — nothing to do.

      const updated: VerificationRecordInternal = {
        ...current,
        status: result.status,
        outputHash: result.outputHash,
        deployedHash: result.deployedHash,
        // Private full log (operators) + public sanitized statusDetail (H3/FIX 6).
        log: result.log,
        statusDetail: result.statusDetail,
        updatedAt: now.toISOString(),
      };
      await db
        .update(verificationRecords)
        .set({ status: result.status, updatedAt: now, record: updated })
        .where(eq(verificationRecords.id, recordId));
    },

    async reapStranded({ timeoutMs, maxAttempts, baseBackoffDelayMs = 1_000, maxBackoffDelayMs = 30_000, nowMs, onReclaimed, onDeadLettered }) {
      const now = nowMs ?? Date.now();
      const cutoff = new Date(now - timeoutMs);
      
      // Fetch all stranded 'building' rows to apply backoff logic in application layer.
      // SQL alone cannot calculate variable delays per reclaim attempt, so we fetch
      // the rows and apply backoff callbacks here before updating (M7 exponential backoff).
      const rows = await db.execute(sql`
        SELECT id, (record->>'attempts')::int AS attempts
        FROM ${verificationRecords}
        WHERE status = 'building' AND updated_at < ${cutoff}
      `);
      
      const list = ((rows as unknown as { rows?: { id: string; attempts: number }[] }).rows ??
        (rows as unknown as { id: string; attempts: number }[])) as { id: string; attempts: number }[];
      
      let reclaimed = 0;
      let deadLettered = 0;
      
      for (const row of list) {
        const attempts = row.attempts ?? 0;
        
        if (attempts >= maxAttempts) {
          // Job exhausted all attempts — dead-letter it
          await db
            .update(verificationRecords)
            .set({
              status: "dead_letter",
              updatedAt: new Date(now),
              record: sql`jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('dead_letter'))`,
            })
            .where(eq(verificationRecords.id, row.id));
          deadLettered++;
          onDeadLettered?.();
        } else {
          // Job can be retried — calculate backoff delay and report it.
          // The delay represents how long this job SHOULD wait before being claimed again.
          // In a future enhancement, this could update a "claimAfter" timestamp in the record.
          // For now, we reclaim to 'submitted' and the natural poll interval provides spacing.
          const backoffDelay = calculateBackoffDelay(attempts, baseBackoffDelayMs, maxBackoffDelayMs);
          onReclaimed?.(attempts);
          
          // Return to submitted for reclaim (backoff delay is advisory/metric only in this version)
          await db
            .update(verificationRecords)
            .set({
              status: "submitted",
              updatedAt: new Date(now),
              record: sql`jsonb_set(${verificationRecords.record}, '{status}', to_jsonb('submitted'))`,
            })
            .where(eq(verificationRecords.id, row.id));
          reclaimed++;
        }
      }
      
      return { reclaimed, deadLettered } satisfies ReapResult;
    },

    async countActive() {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM ${verificationRecords}
        WHERE status IN ('submitted', 'building')
      `);
      const list =
        (rows as unknown as { rows?: { n: number }[] }).rows ??
        (rows as unknown as { n: number }[]);
      return list[0]?.n ?? 0;
    },

    async hasActiveForContract(contractId) {
      const rows = await db.execute(sql`
        SELECT 1 FROM ${verificationRecords}
        WHERE contract_id = ${contractId} AND status IN ('submitted', 'building')
        LIMIT 1
      `);
      const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
      return Array.isArray(list) && list.length > 0;
    },

    async listLatestVerified(limit) {
      // Latest terminal record per contract (DISTINCT ON + updated_at DESC),
      // then keep only those whose latest run is verified with a rebuilt hash —
      // a newer failed run supersedes an older verified one.
      const rows = await db.execute(sql`
        select contract_id, record
        from (
          select distinct on (contract_id) contract_id, status, record
          from ${verificationRecords}
          where status in ('verified', 'failed')
          order by contract_id, updated_at desc
        ) latest
        where status = 'verified'
        limit ${limit}
      `);
      const result: Array<{ contractId: string; outputHash: string }> = [];
      for (const row of rows.rows as Array<{ contract_id: string; record: unknown }>) {
        const record = row.record as VerificationRecordInternal;
        if (record.outputHash) {
          result.push({ contractId: row.contract_id, outputHash: record.outputHash });
        }
      }
      return result;
    },
  };
}
