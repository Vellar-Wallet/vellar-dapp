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
  /** Marks an account as closed (merged away) mid-TTL, immediately evicting any
   * stale open-account entry and caching the closed (`undefined`) state for the
   * remainder of the TTL window (#532). */
  markClosed(accountId: string): void;
  /** Forces a live read from the underlying `AccountReader` mid-TTL and updates
   * (or evicts) the cache entry so an account closed on-chain mid-TTL is never
   * served as a stale open account (#532). */
  getFreshAccount(accountId: string): Promise<HorizonAccount | undefined>;
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
  /** Optional liveness predicate consulted on mid-TTL cache hits for open
   * accounts (#532). When it returns `true`, the cached open-account entry is
   * evicted and re-fetched from the underlying `AccountReader`. */
  isAccountClosed?: (accountId: string, cached: HorizonAccount) => boolean | Promise<boolean>;
}

const DEFAULT_TTL_MS = 30_000;

function isZeroNativeBalanceClosedAccount(account: HorizonAccount): boolean {
  const native = account.balances.find((b) => b.assetType === "native");
  if (!native) return true;
  const parsed = Number(native.balance);
  return !Number.isFinite(parsed) || parsed <= 0;
}

/**
 * Wraps an `AccountReader` with a short-lived, invalidatable cache keyed by
 * account id. `getAccount` transparently serves a fresh-enough cached value
 * instead of re-hitting Horizon; `invalidate`/`invalidateAll`/`markClosed`
 * let a caller force the next read to reflect mid-TTL account closure.
 *
 * Mid-TTL account closure behavior (#287 / #532):
 * 1. Explicit merge/closure (`invalidate(accountId)` or `markClosed(accountId)`):
 *    Immediately evicts the open-account entry mid-TTL so subsequent reads do
 *    not serve a stale open-account snapshot.
 * 2. Live revalidation (`getFreshAccount(accountId)` or `isAccountClosed` hook):
 *    Bypasses the mid-TTL open-account entry, queries the underlying reader,
 *    and caches `undefined` when the account has been closed on-chain.
 * 3. Closed-state guard: Any account snapshot with no positive native XLM
 *    reserve (`<= 0`) cannot be an open Stellar account and is never served
 *    from cache as an open account.
 */
export function createCachedAccountReader(
  reader: AccountReader,
  options: AccountCacheOptions = {},
): CachedAccountReader {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const isAccountClosed = options.isAccountClosed;
  const store = new Map<string, CacheEntry>();

  async function fetchAndStore(accountId: string): Promise<HorizonAccount | undefined> {
    const value = await reader.getAccount(accountId);
    store.set(accountId, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    async getAccount(accountId: string): Promise<HorizonAccount | undefined> {
      const cached = store.get(accountId);
      if (cached && cached.expiresAt > now()) {
        if (cached.value !== undefined) {
          if (
            isZeroNativeBalanceClosedAccount(cached.value) ||
            (isAccountClosed && (await isAccountClosed(accountId, cached.value)))
          ) {
            store.delete(accountId);
            return fetchAndStore(accountId);
          }
        }
        return cached.value;
      }

      return fetchAndStore(accountId);
    },

    async getFreshAccount(accountId: string): Promise<HorizonAccount | undefined> {
      store.delete(accountId);
      return fetchAndStore(accountId);
    },

    invalidate(accountId: string): void {
      store.delete(accountId);
    },

    markClosed(accountId: string): void {
      store.set(accountId, { value: undefined, expiresAt: now() + ttlMs });
    },

    invalidateAll(): void {
      store.clear();
    },
  };
}
