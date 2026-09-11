// Persistence seams for marketplace-service (new-build-technical-doc.md §5.1).
// In-memory implementations back tests and DB-less local dev; the Postgres
// implementations in db/pg-repository.ts satisfy the same interfaces.

export type ListingStatus = "pending" | "active" | "paused" | "removed";
export type ListingScheme = "exact" | "upto";

export interface ListingRecord {
  id: string;
  sellerAddress: string;
  resourceUrl: string;
  title: string;
  description: string | null;
  /** Base units. Stringly-typed at the boundary so a 7-decimal asset's amount
   * never round-trips through a lossy JS number. */
  priceAtomic: string;
  asset: string;
  scheme: ListingScheme;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
  firstSettledAt: string | null;
  totalSettlements: string;
  totalRevenue: string;
}

export interface ListingUpdate {
  title?: string;
  description?: string;
  priceAtomic?: string;
  scheme?: ListingScheme;
  status?: ListingStatus;
}

export class DuplicateListingError extends Error {
  constructor(resourceUrl: string) {
    super(`A listing already exists for ${resourceUrl}`);
    this.name = "DuplicateListingError";
  }
}

export interface ListingRepository {
  /** Rejects with DuplicateListingError when resourceUrl is already listed —
   * §14 Q4: first registrant with a valid signature wins. */
  insert(record: ListingRecord): Promise<void>;
  findById(id: string): Promise<ListingRecord | undefined>;
  findByResourceUrl(resourceUrl: string): Promise<ListingRecord | undefined>;
  listBySeller(sellerAddress: string): Promise<ListingRecord[]>;
  update(id: string, patch: ListingUpdate, updatedAt: Date): Promise<ListingRecord | undefined>;
}

export interface NonceRecord {
  nonce: string;
  address: string;
  createdAt: string;
  usedAt: string | null;
  expiresAt: string;
}

export interface NonceRepository {
  insert(record: NonceRecord): Promise<void>;
  /**
   * Atomically consume a nonce: succeeds ONLY if the nonce exists, belongs to
   * `address`, is unused, and has not expired as of `asOf` — and marks it used
   * in the same operation. Returns false otherwise.
   *
   * Single statement by design: a read-then-write would let two concurrent
   * registrations both observe an unused nonce and both succeed.
   */
  consume(nonce: string, address: string, asOf: Date): Promise<boolean>;
  /** Deletes expired rows; returns how many. Called by the background sweep. */
  deleteExpired(asOf: Date): Promise<number>;
}

export function createMemoryListingRepository(): ListingRepository {
  const byId = new Map<string, ListingRecord>();
  return {
    async insert(record) {
      for (const existing of byId.values()) {
        if (existing.resourceUrl === record.resourceUrl) {
          throw new DuplicateListingError(record.resourceUrl);
        }
      }
      byId.set(record.id, { ...record });
    },
    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found } : undefined;
    },
    async findByResourceUrl(resourceUrl) {
      for (const existing of byId.values()) {
        if (existing.resourceUrl === resourceUrl) return { ...existing };
      }
      return undefined;
    },
    async listBySeller(sellerAddress) {
      return [...byId.values()]
        .filter((l) => l.sellerAddress === sellerAddress)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((l) => ({ ...l }));
    },
    async update(id, patch, updatedAt) {
      const existing = byId.get(id);
      if (!existing) return undefined;
      const next: ListingRecord = {
        ...existing,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        updatedAt: updatedAt.toISOString(),
      };
      byId.set(id, next);
      return { ...next };
    },
  };
}

export function createMemoryNonceRepository(): NonceRepository {
  const byNonce = new Map<string, NonceRecord>();
  return {
    async insert(record) {
      byNonce.set(record.nonce, { ...record });
    },
    async consume(nonce, address, asOf) {
      const found = byNonce.get(nonce);
      if (!found) return false;
      if (found.address !== address) return false;
      if (found.usedAt !== null) return false;
      if (new Date(found.expiresAt).getTime() <= asOf.getTime()) return false;
      byNonce.set(nonce, { ...found, usedAt: asOf.toISOString() });
      return true;
    },
    async deleteExpired(asOf) {
      let deleted = 0;
      for (const [key, record] of byNonce) {
        if (new Date(record.expiresAt).getTime() < asOf.getTime()) {
          byNonce.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
