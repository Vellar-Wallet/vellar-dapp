import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "./client";
import { marketplaceListings, marketplaceNonces } from "./schema";
import {
  DuplicateListingError,
  type ListingRecord,
  type ListingRepository,
  type ListingScheme,
  type ListingStatus,
  type ListingUpdate,
  type NonceRepository,
} from "../repository";

// Postgres implementations of the marketplace seams. Rows carry Date and
// bigint; the domain interfaces use ISO strings and decimal strings, so the
// conversion lives here and nowhere else.

type ListingRow = typeof marketplaceListings.$inferSelect;

function toRecord(row: ListingRow): ListingRecord {
  return {
    id: row.id,
    sellerAddress: row.sellerAddress,
    resourceUrl: row.resourceUrl,
    title: row.title,
    description: row.description,
    priceAtomic: row.priceAtomic.toString(),
    asset: row.asset,
    scheme: row.scheme as ListingScheme,
    status: row.status as ListingStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    firstSettledAt: row.firstSettledAt ? row.firstSettledAt.toISOString() : null,
    totalSettlements: row.totalSettlements.toString(),
    totalRevenue: row.totalRevenue.toString(),
  };
}

/** Postgres unique-violation. Raised when two sellers race for one URL. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function createPgListingRepository(db: Db): ListingRepository {
  return {
    async insert(record) {
      try {
        await db.insert(marketplaceListings).values({
          id: record.id,
          sellerAddress: record.sellerAddress,
          resourceUrl: record.resourceUrl,
          title: record.title,
          description: record.description,
          priceAtomic: BigInt(record.priceAtomic),
          asset: record.asset,
          scheme: record.scheme,
          status: record.status,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
          firstSettledAt: record.firstSettledAt ? new Date(record.firstSettledAt) : null,
          totalSettlements: BigInt(record.totalSettlements),
          totalRevenue: BigInt(record.totalRevenue),
        });
      } catch (err) {
        // The UNIQUE index on resource_url is the real arbiter of §14 Q4's
        // "first registrant wins" — a pre-check would race.
        if (isUniqueViolation(err)) throw new DuplicateListingError(record.resourceUrl);
        throw err;
      }
    },

    async findById(id) {
      const [row] = await db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, id))
        .limit(1);
      return row ? toRecord(row) : undefined;
    },

    async findByResourceUrl(resourceUrl) {
      const [row] = await db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.resourceUrl, resourceUrl))
        .limit(1);
      return row ? toRecord(row) : undefined;
    },

    async listBySeller(sellerAddress) {
      const rows = await db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.sellerAddress, sellerAddress))
        .orderBy(desc(marketplaceListings.createdAt));
      return rows.map(toRecord);
    },

    async update(id, patch, updatedAt) {
      const values: Partial<typeof marketplaceListings.$inferInsert> = { updatedAt };
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.priceAtomic !== undefined) values.priceAtomic = BigInt(patch.priceAtomic);
      if (patch.scheme !== undefined) values.scheme = patch.scheme;
      if (patch.status !== undefined) values.status = patch.status;
      const [row] = await db
        .update(marketplaceListings)
        .set(values)
        .where(eq(marketplaceListings.id, id))
        .returning();
      return row ? toRecord(row) : undefined;
    },
  };
}

export function createPgNonceRepository(db: Db): NonceRepository {
  return {
    async insert(record) {
      await db.insert(marketplaceNonces).values({
        nonce: record.nonce,
        address: record.address,
        createdAt: new Date(record.createdAt),
        usedAt: record.usedAt ? new Date(record.usedAt) : null,
        expiresAt: new Date(record.expiresAt),
      });
    },

    /**
     * One conditional UPDATE does the whole check-and-consume: the WHERE clause
     * carries every precondition (right address, unused, unexpired), so two
     * concurrent registrations racing the same nonce produce exactly one
     * updated row — the loser sees zero rows and is refused. A SELECT-then-
     * UPDATE would let both through.
     */
    async consume(nonce, address, asOf) {
      const updated = await db
        .update(marketplaceNonces)
        .set({ usedAt: asOf })
        .where(
          and(
            eq(marketplaceNonces.nonce, nonce),
            eq(marketplaceNonces.address, address),
            isNull(marketplaceNonces.usedAt),
            gt(marketplaceNonces.expiresAt, asOf),
          ),
        )
        .returning({ nonce: marketplaceNonces.nonce });
      return updated.length === 1;
    },

    async deleteExpired(asOf) {
      const deleted = await db
        .delete(marketplaceNonces)
        .where(lt(marketplaceNonces.expiresAt, asOf))
        .returning({ nonce: marketplaceNonces.nonce });
      return deleted.length;
    },
  };
}
