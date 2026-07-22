import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { verificationRecords } from "@vela/verification-service/db-schema";
import type { VerificationRecordInternal } from "@vela/verification-service/server";
import type { ClaimedJob, VerificationJobStore } from "./job-store";

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
      const rows = await db
        .update(verificationRecords)
        .set({ status: "building", updatedAt: new Date() })
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
        log: result.log,
        updatedAt: now.toISOString(),
      };
      await db
        .update(verificationRecords)
        .set({ status: result.status, updatedAt: now, record: updated })
        .where(eq(verificationRecords.id, recordId));
    },
  };
}
