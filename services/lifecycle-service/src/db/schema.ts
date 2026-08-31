import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Cleanup job queue schema (Issue #293).
 *
 * The cleanup_jobs table is the persistent queue for async account cleanup operations.
 * Per-account FIFO ordering is enforced via ordering by (accountId, createdAt) in the
 * worker's claim query, ensuring jobs for the same account are processed sequentially.
 *
 * Status lifecycle:
 *   - 'queued': newly submitted, waiting to be claimed
 *   - 'processing': claimed by a worker, in-flight
 *   - 'completed': cleanup operations built and signed, ready to submit on-chain
 *   - 'failed': permanent failure (invalid account, destination validation failed)
 *   - 'dead_letter': exhausted all retry attempts
 */

export interface CleanupJobRecord {
  id: string;
  accountId: string;
  destination: string;
  /** ISO 8601 timestamp when job was submitted */
  submittedAt: string;
  /** Unsigned cleanup transaction steps (array of XDR strings) */
  steps?: string[];
  /** Cleanup plan (blockers, mergeReady status, etc.) */
  plan?: unknown;
  /** Error message if status is 'failed' or 'dead_letter' */
  error?: string;
  /** Attempt counter for backoff + dead-letter logic */
  attempts: number;
}

export const cleanupJobs = pgTable(
  "cleanup_jobs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull(), // 'queued', 'processing', 'completed', 'failed', 'dead_letter'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    record: jsonb("record").notNull().$type<CleanupJobRecord>(),
  },
  (table) => ({
    byAccount: index("cleanup_jobs_account_idx").on(table.accountId),
    byStatus: index("cleanup_jobs_status_idx").on(table.status),
    // Per-account ordering index: ensures FIFO within each account
    byAccountCreated: index("cleanup_jobs_account_created_idx").on(table.accountId, table.createdAt),
  }),
);
