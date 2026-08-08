import { bigint, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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

// Rolling-window funding-path spend ledger for the sponsor-funded "deploy" line
// (security-audit.md H1/M2/FIX 3). Same shape as wallet-service's ledger so the
// shared createPgSpendBudget works unchanged.
export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: text("id").primaryKey(),
    line: text("line").notNull(),
    network: text("network").notNull(),
    stroops: bigint("stroops", { mode: "bigint" }).notNull(),
    count: integer("count").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("spend_ledger_line_network_at_idx").on(table.line, table.network, table.at)],
);
