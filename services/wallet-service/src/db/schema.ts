import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
