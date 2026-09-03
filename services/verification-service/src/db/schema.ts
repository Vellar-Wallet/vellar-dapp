import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { VerificationRecordInternal } from "../server";

// Postgres schema for verification-service (idea.md §9: verification_records).
// A verification record is read/written whole, so the full record lives in a
// jsonb column, with id/contractId/status/updatedAt promoted to scalar columns:
//   - contractId + updatedAt: the status/history lookups filter+sort on these.
//   - status: worker-service claims jobs with WHERE status='submitted', so it
//     must be an indexed scalar, not buried in jsonb.
export const verificationRecords = pgTable(
  "verification_records",
  {
    id: text("id").primaryKey(),
    contractId: text("contract_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    record: jsonb("record").notNull().$type<VerificationRecordInternal>(),
  },
  (table) => ({
    byContract: index("verification_records_contract_idx").on(table.contractId),
    byStatus: index("verification_records_status_idx").on(table.status),
  }),
);

// Archive table for the ETL cleanup job (issue #345). Rows are copied here from
// verification_records before deletion, giving a permanent audit trail of every
// completed verification run. Schema is identical to the live table plus an
// archived_at column that records when the cleanup job moved the row.
// Corresponds to migration 0001_archive.sql.
export const verificationRecordsArchive = pgTable(
  "verification_records_archive",
  {
    id: text("id").primaryKey(),
    contractId: text("contract_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    record: jsonb("record").notNull().$type<VerificationRecordInternal>(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => ({
    byContract: index("vr_archive_contract_idx").on(table.contractId),
    byStatus: index("vr_archive_status_idx").on(table.status),
    byArchivedAt: index("vr_archive_archived_at_idx").on(table.archivedAt),
  }),
);
