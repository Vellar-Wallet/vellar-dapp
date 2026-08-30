import type { AccountReader, HorizonAccount } from "./horizon";

// Cache invalidation on account merge (#287). `/lifecycle/inspect` and
// `/lifecycle/plan` both call `AccountReader.getAccount` for the same
// account repeatedly during a single cleanup workflow (inspect, then plan,
// then merge all read the source account; the merge preflight re-reads it
// again per server.ts's own comment on the MergePreflightValidator). Without
// caching, that's a live Horizon round-trip on every call; with a naive
// cache and no invalidation, a merge would leave stale reads for both the
// source account (now merged away — should read as not-found) and the
// destination account (balance changed — should read as its new balance).

export interface CachedAccountReader extends AccountReader {
  /** Evict a single account's cached entry, if present. Called for both the
   * source and destination account as part of a completed merge — see
   * server.ts's POST /lifecycle/merge handler. A no-op if the account was
   * never cached (e.g. `getAccount` was never called for it), so callers
   * don't need to check first. */
  invalidate(accountId: string): void;
  /** Evict everything. Not used by the merge flow itself (which invalidates
   * only the two affected accounts) — exposed for operational use (e.g. an
   * admin endpoint or test teardown) and because a store-wide cache is
   * otherwise unreachable from outside this module. */
  invalidateAll(): void;
}

interface CacheEntry {
  value: HorizonAccount | undefined;
  expiresAt: number;
}

export interface AccountCacheOptions {
  /** How long a cached read stays valid before a normal (non-merge-triggered)
   * expiry. Default 30s — short enough that even an un-invalidated read
   * (e.g. a future call site that doesn't know about a merge) can't stay
   * wrong for long, long enough to avoid hammering Horizon across the
   * inspect → plan → merge sequence of one cleanup workflow. */
  ttlMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Wraps an `AccountReader` with a short-lived, invalidatable cache keyed by
 * account id. `getAccount` transparently serves a fresh-enough cached value
 * instead of re-hitting Horizon; `invalidate`/`invalidateAll` let a caller
 * (the merge route) force the next read to go live again.
 *
 * A `getAccount` call that returns "not found" (`undefined`) is cached too —
 * this is what makes a merged-away source account correctly read as gone
 * once its cache entry is invalidated and re-fetched, rather than only
 * caching successful lookups.
 */
export function createCachedAccountReader(
  reader: AccountReader,
  options: AccountCacheOptions = {},
): CachedAccountReader {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const store = new Map<string, CacheEntry>();

  return {
    async getAccount(accountId: string): Promise<HorizonAccount | undefined> {
      const cached = store.get(accountId);
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }

      const value = await reader.getAccount(accountId);
      store.set(accountId, { value, expiresAt: now() + ttlMs });
      return value;
    },

    invalidate(accountId: string): void {
      store.delete(accountId);
    },

    invalidateAll(): void {
      store.clear();
    },
  };
}
