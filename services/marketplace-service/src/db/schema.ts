import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// Postgres schema for marketplace-service (new-build-technical-doc.md §5.1).
// Timestamps are timestamptz; repos convert to/from the ISO strings the domain
// interfaces use. Ids are text, not uuid: a junk id in a lookup must 404, not
// 500 on a failed cast (same rule as wallet_sessions.id).

export const marketplaceListings = pgTable(
  "marketplace_listings",
  {
    id: text("id").primaryKey(),
    sellerAddress: text("seller_address").notNull(),
    resourceUrl: text("resource_url").notNull().unique(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    // Money is bigint-mode: base units can exceed Number.MAX_SAFE_INTEGER for
    // 7-decimal assets, and JS number rounding on a price is a correctness bug.
    priceAtomic: bigint("price_atomic", { mode: "bigint" }).notNull(),
    asset: text("asset").notNull(),
    scheme: varchar("scheme", { length: 20 }).notNull().default("exact"),
    // pending | active | paused | removed. A listing becomes active on its
    // first settlement (§5.2), never at registration time.
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    firstSettledAt: timestamp("first_settled_at", { withTimezone: true, mode: "date" }),
    totalSettlements: bigint("total_settlements", { mode: "bigint" })
      .notNull()
      // SQL default, not `.default(0n)`: drizzle-kit 0.31.10 throws
      // "Do not know how to serialize a BigInt" when snapshotting a JS bigint.
      .default(sql`0`),
    totalRevenue: bigint("total_revenue", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (table) => [
    index("marketplace_listings_seller_address_idx").on(table.sellerAddress),
    index("marketplace_listings_status_idx").on(table.status),
    index("marketplace_listings_resource_url_idx").on(table.resourceUrl),
  ],
);

export const marketplaceSettlements = pgTable(
  "marketplace_settlements",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").references(() => marketplaceListings.id),
    txHash: varchar("tx_hash", { length: 64 }).notNull().unique(),
    buyerAddress: text("buyer_address"),
    amountAtomic: bigint("amount_atomic", { mode: "bigint" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }).notNull(),
    ledger: integer("ledger").notNull(),
  },
  (table) => [
    index("marketplace_settlements_listing_id_idx").on(table.listingId),
    index("marketplace_settlements_settled_at_idx").on(table.settledAt),
  ],
);

// Seller-registration nonces (new-build-technical-doc.md §5.2). The spec
// assumed Redis; this repo has no Redis anywhere, so the store is Postgres
// (docs/decisions.md). A nonce is SINGLE-USE (used_at stamped on first
// successful use; a second use is refused) and TIME-LIMITED (expires_at =
// created_at + 5 min). Both properties are enforced in one conditional UPDATE
// so two concurrent requests cannot both consume the same nonce.
export const marketplaceNonces = pgTable(
  "marketplace_nonces",
  {
    nonce: text("nonce").primaryKey(),
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("marketplace_nonces_address_idx").on(table.address),
    index("marketplace_nonces_expires_at_idx").on(table.expiresAt),
  ],
);
