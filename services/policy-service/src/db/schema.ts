import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PolicyRecord } from "../server";

// Postgres schema for policy-service (idea.md §9 policies table). A policy
// record is read and written whole (no per-field querying), so the full record
// lives in a jsonb column with the id, status, and createdAt promoted to
// scalar columns for indexing/inspection.
export const policies = pgTable("policies", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  record: jsonb("record").notNull().$type<PolicyRecord>(),
});
