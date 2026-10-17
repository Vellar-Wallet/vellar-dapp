/**
 * In-memory cache for wallet-service.
 *
 * Provides simple TTL-based caching for frequently accessed resources:
 * - account data
 * - balances
 * - nonces
 * - transaction history
 *
 * In production, this can be replaced with Redis or memcached by changing
 * the implementation while keeping the CacheOperation interface constant.
 */

import type { CacheResourceType, CacheGetResult, CacheOperation } from "./cache-metrics";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

export interface MemoryCacheStoreOptions {
  ttlMs?: number;
  balanceMaxAgeMs?: number;
}

/**
 * In-memory TTL-based cache. Entries expire after the specified TTL or balance max-age ceiling.
 */
export class MemoryCacheStore implements CacheOperation {
  private store = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;
  private balanceMaxAgeMs?: number;

  constructor(options?: number | MemoryCacheStoreOptions) {
    if (typeof options === "number") {
      this.ttlMs = options;
    } else {
      this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
      this.balanceMaxAgeMs = options?.balanceMaxAgeMs;
    }
  }

  private makeKey(resource: CacheResourceType, key: string): string {
    return `${resource}:${key}`;
  }

  private isExpired(entry: CacheEntry<unknown>, resource?: CacheResourceType): boolean {
    const now = Date.now();
    if (now > entry.expiresAt) {
      return true;
    }
    if (resource === "balance" && this.balanceMaxAgeMs !== undefined) {
      if (now - entry.createdAt > this.balanceMaxAgeMs) {
        return true;
      }
    }
    return false;
  }

  async get<T = unknown>(resource: CacheResourceType, key: string): Promise<CacheGetResult<T>> {
    const fullKey = this.makeKey(resource, key);
    const entry = this.store.get(fullKey);

    if (!entry) {
      return { hit: false };
    }

    if (this.isExpired(entry, resource)) {
      this.store.delete(fullKey);
      return { hit: false };
    }

    return { hit: true, value: entry.value as T };
  }

  async set<T = unknown>(
    resource: CacheResourceType,
    key: string,
    value: T,
    options?: { preserveCreatedAt?: boolean },
  ): Promise<void> {
    const fullKey = this.makeKey(resource, key);
    const existing = this.store.get(fullKey);
    const now = Date.now();
    const createdAt = options?.preserveCreatedAt && existing ? existing.createdAt : now;
    this.store.set(fullKey, {
      value,
      expiresAt: now + this.ttlMs,
      createdAt,
    });
  }

  /**
   * Refreshes the TTL of an existing entry without updating its createdAt timestamp.
   */
  async touch(resource: CacheResourceType, key: string): Promise<boolean> {
    const fullKey = this.makeKey(resource, key);
    const entry = this.store.get(fullKey);
    if (!entry || this.isExpired(entry, resource)) {
      this.store.delete(fullKey);
      return false;
    }
    entry.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  async delete(resource: CacheResourceType, key: string): Promise<void> {
    const fullKey = this.makeKey(resource, key);
    this.store.delete(fullKey);
  }

  /**
   * Explicitly invalidate a cache entry manually.
   */
  async invalidate(resource: CacheResourceType, key: string): Promise<void> {
    await this.delete(resource, key);
  }

  /**
   * Explicitly invalidate a balance cache entry manually (e.g. after a confirmed transaction).
   */
  async invalidateBalance(key: string): Promise<void> {
    await this.delete("balance", key);
  }

  /**
   * Clear all entries from the cache (useful for testing).
   */
  async clear(): Promise<void> {
    this.store.clear();
  }

  /**
   * Get the number of entries currently in the cache (useful for testing/monitoring).
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Clean up expired entries (can be called periodically to reclaim memory).
   */
  async cleanup(): Promise<number> {
    let removed = 0;

    for (const [key, entry] of this.store.entries()) {
      const resource = key.split(":")[0] as CacheResourceType;
      if (this.isExpired(entry, resource)) {
        this.store.delete(key);
        removed += 1;
      }
    }

    return removed;
  }
}

/**
 * Create a no-op cache (useful for testing or when caching is disabled).
 */
export class NoOpCache implements CacheOperation {
  async get<T = unknown>(_resource: CacheResourceType, _key: string): Promise<CacheGetResult<T>> {
    return { hit: false };
  }

  async set<T = unknown>(_resource: CacheResourceType, _key: string, _value: T): Promise<void> {
    // no-op
  }

  async delete(_resource: CacheResourceType, _key: string): Promise<void> {
    // no-op
  }

  async invalidate(_resource: CacheResourceType, _key: string): Promise<void> {
    // no-op
  }

  async invalidateBalance(_key: string): Promise<void> {
    // no-op
  }
}
