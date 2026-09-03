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
}

/**
 * In-memory TTL-based cache. Entries expire after the specified TTL.
 */
export class MemoryCacheStore implements CacheOperation {
  private store = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    // Default 5 minutes
    this.ttlMs = ttlMs;
  }

  private makeKey(resource: CacheResourceType, key: string): string {
    return `${resource}:${key}`;
  }

  private isExpired(entry: CacheEntry<unknown>): boolean {
    return Date.now() > entry.expiresAt;
  }

  async get<T = unknown>(
    resource: CacheResourceType,
    key: string,
  ): Promise<CacheGetResult<T>> {
    const fullKey = this.makeKey(resource, key);
    const entry = this.store.get(fullKey);

    if (!entry) {
      return { hit: false };
    }

    if (this.isExpired(entry)) {
      this.store.delete(fullKey);
      return { hit: false };
    }

    return { hit: true, value: entry.value as T };
  }

  async set<T = unknown>(
    resource: CacheResourceType,
    key: string,
    value: T,
  ): Promise<void> {
    const fullKey = this.makeKey(resource, key);
    this.store.set(fullKey, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async delete(resource: CacheResourceType, key: string): Promise<void> {
    const fullKey = this.makeKey(resource, key);
    this.store.delete(fullKey);
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
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
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
  async get<T = unknown>(): Promise<CacheGetResult<T>> {
    return { hit: false };
  }

  async set<T = unknown>(): Promise<void> {
    // no-op
  }

  async delete(): Promise<void> {
    // no-op
  }
}
