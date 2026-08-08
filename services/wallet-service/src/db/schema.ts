import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Postgres schema for wallet-service (idea.md §9: wallets, wallet_sessions,
// activity_logs). Timestamps are timestamptz; repos convert to/from the ISO
// strings the domain interfaces use.

export const wallets = pgTable(
  "wallets",
  {
    keyId: text("key_id").notNull(),
    contractId: text("contract_id").notNull(),
    network: text("network").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // One wallet per passkey per network — mirrors DuplicateWalletError semantics.
  (table) => [primaryKey({ columns: [table.keyId, table.network] })],
);

export const walletSessions = pgTable("wallet_sessions", {
  // text, not uuid: junk ids in GET /wallet/session/:id must 404, not 500 on cast.
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull(),
  network: text("network").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const activityLogs = pgTable("activity_logs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  data: jsonb("data").notNull().$type<Record<string, unknown>>(),
});

// Rolling-window funding-path spend ledger (security-audit.md H1/M2/FIX 3).
// One row per sponsored/created call; the budget check sums stroops and counts
// rows within the window for (line, network). Indexed on (line, network, at)
// so the window scan is cheap.
export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: text("id").primaryKey(),
    line: text("line").notNull(), // "sponsor" | "deploy" | "create"
    network: text("network").notNull(),
    stroops: bigint("stroops", { mode: "bigint" }).notNull(),
    count: integer("count").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("spend_ledger_line_network_at_idx").on(table.line, table.network, table.at)],
);
