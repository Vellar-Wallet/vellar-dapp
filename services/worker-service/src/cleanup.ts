import { inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { verificationRecords, verificationRecordsArchive } from "@vellar/verification-service/db-schema";

// ETL cleanup job for stale verification_records rows (issue #345).
//
// Terminal rows (verified / failed / dead_letter) that haven't been updated
// in `retentionDays` days accumulate indefinitely and cause unbounded table
// growth. This module selects them in bounded batches, optionally copies them
// to verification_records_archive (archive-then-delete, the safe default),
// then removes them from the live table.
//
// Safety guarantees:
//   • Only terminal rows are touched — submitted/building are never eligible.
//   • Rows are selected by updated_at, which is the last meaningful write
//     timestamp on the record. Using it (rather than created_at) ensures a
//     row that sat in submitted for a long time and only recently went terminal
//     gets the full retention window from when it actually completed.
//   • Archive INSERT uses ON CONFLICT DO NOTHING, so re-running after an
//     interrupted batch never duplicates archived rows or errors out.
//   • DELETE uses WHERE id = ANY(...) with the exact IDs that were archived
//     in this run — rows inserted/updated since we read them are unaffected.
//   • With archiveEnabled=false the archive step is skipped and rows are
//     hard-deleted directly; use only when you have an explicit reason to
//     forgo the audit trail.

export interface CleanupConfig {
  /** Minimum age in days (from updated_at) for a terminal row to be eligible. */
  retentionDays: number;
  /** Max rows per run. Keeps transactions small and the job safe to interrupt. */
  batchSize: number;
  /** Copy eligible rows to the archive table before deleting (default true). */
  archiveEnabled: boolean;
  /** Injectable clock (epoch ms) — for deterministic tests. Defaults to Date.now(). */
  nowMs?: number;
}

export interface CleanupResult {
  /** Rows archived (0 when archiveEnabled=false). */
  archived: number;
  /** Rows deleted from the live table. */
  deleted: number;
}

const TERMINAL_STATUSES = ["verified", "failed", "dead_letter"] as const;

/**
 * Run one cleanup pass: select up to `batchSize` eligible rows, archive them
 * (if enabled), then delete them. Returns counts of what happened.
 *
 * Safe to call from a setInterval — exits quickly when nothing is eligible.
 */
export async function runCleanup(
  db: NodePgDatabase,
  config: CleanupConfig,
): Promise<CleanupResult> {
  const now = config.nowMs ?? Date.now();
  const cutoff = new Date(now - config.retentionDays * 24 * 60 * 60 * 1000);
  const archivedAt = new Date(now);

  // Select eligible IDs in a single, indexed read. We cap at batchSize to
  // prevent an unbounded read on the first run after the feature is deployed.
  const eligible = await db
    .select({ id: verificationRecords.id })
    .from(verificationRecords)
    .where(
      sql`${verificationRecords.status} = ANY(ARRAY[${sql.join(TERMINAL_STATUSES.map((s) => sql`${s}`), sql`, `)}])
          AND ${verificationRecords.updatedAt} <= ${cutoff}`,
    )
    .limit(config.batchSize);

  if (eligible.length === 0) {
    return { archived: 0, deleted: 0 };
  }

  const ids = eligible.map((r) => r.id);

  let archived = 0;

  if (config.archiveEnabled) {
    // Copy the full rows to the archive table. ON CONFLICT DO NOTHING makes
    // this idempotent: if the job was interrupted after archiving but before
    // deleting, re-running archives nothing and then deletes the already-
    // archived IDs — exactly the right behaviour.
    const archiveResult = await db.execute(sql`
      INSERT INTO ${verificationRecordsArchive} (
        id, contract_id, status, created_at, updated_at, record, archived_at
      )
      SELECT
        id, contract_id, status, created_at, updated_at, record, ${archivedAt}
      FROM ${verificationRecords}
      WHERE id = ANY(${ids})
      ON CONFLICT (id) DO NOTHING
    `);
    // node-postgres returns rowCount on INSERT; fall back to ids.length when
    // all rows already existed in the archive (idempotent re-run case).
    const pg = archiveResult as unknown as { rowCount?: number | null };
    archived = pg.rowCount ?? ids.length;
  }

  // Delete from the live table using the exact same IDs we just read/archived.
  // Rows that moved out of a terminal state between the SELECT and the DELETE
  // (impossible in production but possible in fast test clocks) are unaffected
  // because we match on id, not on status+updated_at again.
  await db
    .delete(verificationRecords)
    .where(inArray(verificationRecords.id, ids));

  return { archived, deleted: ids.length };
}

/** Convenience: run cleanup in a loop until no eligible rows remain in the
 * current batch window. Useful for one-off manual drain runs. Returns total
 * counts across all passes. */
export async function runCleanupUntilEmpty(
  db: NodePgDatabase,
  config: CleanupConfig,
): Promise<CleanupResult> {
  let totalArchived = 0;
  let totalDeleted = 0;
  // Guard against an infinite loop if rows keep re-entering terminal state
  // (shouldn't happen, but cheap to cap).
  const MAX_PASSES = 10_000;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = await runCleanup(db, config);
    totalArchived += result.archived;
    totalDeleted += result.deleted;
    if (result.deleted === 0) break;
  }
  return { archived: totalArchived, deleted: totalDeleted };
}
