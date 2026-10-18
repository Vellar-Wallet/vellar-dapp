import { normalizeOrigin } from "@vellar/provider-sdk";

interface CacheEntry<Value> {
  value: Value;
  expiresAt: number;
}

export interface OriginPermissionCacheOptions {
  ttlMs: number;
  now?: () => number;
}

/**
 * Payload emitted when an origin permission grant is revoked from the browser
 * extension UI or provider disconnect flow.
 *
 * Architectural contract (#547):
 * - While origin grants are authoritative in extension storage, the extension
 *   forwards revocation events to `createRevocationInvalidationHook` (or
 *   `OriginPermissionCache.onRevoke`) so cached permission lookups are evicted
 *   immediately rather than surviving until `ttlMs` expires.
 * - Once server-side permission records (#412) land, the revocation mutation
 *   handler in `permission-service` calls this same hook right after committing
 *   the revocation in Postgres so in-memory caches stay consistent with durable
 *   grant state.
 */
export interface ExtensionPermissionRevocationEvent {
  origin: string;
  accountId?: string;
  network?: string;
  revokedAt?: string;
}

export interface RevocationInvalidationResult {
  origin: string;
  normalizedOrigin: string;
  invalidated: boolean;
}

export type RevocationInvalidationHook = (
  event: ExtensionPermissionRevocationEvent | string,
) => RevocationInvalidationResult;

function canonicalCacheKey(origin: string): string {
  return normalizeOrigin(origin) ?? origin;
}

export class OriginPermissionCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private readonly now: () => number;

  constructor({ ttlMs, now = Date.now }: OriginPermissionCacheOptions) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Origin permission cache TTL must be greater than zero");
    }
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private readonly ttlMs: number;

  get(origin: string): Value | undefined {
    const key = canonicalCacheKey(origin);
    const entry = this.entries.get(key) ?? this.entries.get(origin);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.entries.delete(origin);
      return undefined;
    }
    return entry.value;
  }

  set(origin: string, value: Value): void {
    const key = canonicalCacheKey(origin);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(origin: string): boolean {
    const key = canonicalCacheKey(origin);
    const deletedCanonical = this.entries.delete(key);
    const deletedRaw = key !== origin ? this.entries.delete(origin) : false;
    return deletedCanonical || deletedRaw;
  }

  /**
   * Evicts a cached origin entry on permission revocation.
   *
   * Calling `invalidate` for an origin that is not currently cached (or has
   * already expired) is a safe no-op and returns `false`.
   */
  invalidate(origin: string): boolean {
    const key = canonicalCacheKey(origin);
    const entry = this.entries.get(key) ?? this.entries.get(origin);
    const wasLive = entry !== undefined && entry.expiresAt > this.now();
    this.entries.delete(key);
    if (key !== origin) {
      this.entries.delete(origin);
    }
    return wasLive;
  }

  /**
   * Handles an extension-side (or server-side #412) permission revocation by
   * evicting the corresponding origin entry from the cache. Safe no-op when the
   * origin is not present in the cache.
   */
  onRevoke(event: ExtensionPermissionRevocationEvent | string): RevocationInvalidationResult {
    const rawOrigin = typeof event === "string" ? event : event.origin;
    const normalizedOrigin = canonicalCacheKey(rawOrigin);
    const invalidated = this.invalidate(rawOrigin);
    return {
      origin: rawOrigin,
      normalizedOrigin,
      invalidated,
    };
  }
}

/**
 * Creates a standalone cache-invalidation hook bound to `cache`.
 *
 * Invoked when the browser extension revokes an origin grant today, and called
 * by the server-side revocation write path once durable permission records
 * (#412) are persisted in Postgres. Invalidating an uncached origin is a safe
 * no-op.
 */
export function createRevocationInvalidationHook<Value>(
  cache: OriginPermissionCache<Value>,
): RevocationInvalidationHook {
  return (event) => cache.onRevoke(event);
}
