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
  // text, not uuid: junk ids in a session lookup must 404, not 500 on cast.
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull(),
  network: text("network").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: "date" }).notNull(),
  // A session id is a bearer capability for the session routes (RA-3/M1), so it
  // expires: 7-day sliding window, enforced by the guard. Rows past this are
  // treated as absent. NOT NULL so a pre-expiry row can never read as immortal.
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
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

// Transaction submission queue for exactly-once processing (Issue #291).
// Implements idempotent submission with transient retry-with-backoff and dead-letter tracking.
// Status lifecycle: submitted → processing → succeeded/failed/dead_letter.
// The record JSONB stores the full submission state for observability and replay.
export const transactionSubmissions = pgTable(
  "transaction_submissions",
  {
    // Stellar transaction hash — the transaction ID. Uniquely identifies a transaction.
    transactionId: text("transaction_id").primaryKey(),
    // Status: 'submitted' (queued), 'processing' (claimed by worker), 'succeeded'
    // (confirmed on-chain), 'failed' (permanent error), 'dead_letter' (max retries exceeded)
    status: text("status").notNull(),
    // Full submission record (JSONB): includes submitter choice, network, signedXdr,
    // attempts count, error details, timestamps, worker ID for tracing.
    record: jsonb("record").notNull().$type<Record<string, unknown>>(),
    // Timestamp when the record was created (first submission).
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    // Last update: status flip, retry, etc. Used for reaper to find abandoned jobs.
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    // TTL expiration time (ISO string). Processed records expire after 48 hours.
    // In-flight records expire after 5 minutes to allow retry if worker crashes.
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    // Composite index for polling: claim submitted records ordered by creation time.
    index("tx_submissions_status_created_idx").on(table.status, table.createdAt),
    // Index for TTL-based cleanup: find expired records.
    index("tx_submissions_expires_at_idx").on(table.expiresAt),
  ],
);
