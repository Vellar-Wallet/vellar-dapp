/**
 * Cache metrics wrapper and instrumentation for wallet-service.
 *
 * Tracks cache hit/miss ratios for different resource types:
 * - balance: account balance queries
 * - nonce: account nonce/sequence tracking
 * - account: full account details
 * - tx-history: transaction history caches
 *
 * Metrics exposed:
 * - wallet_service_cache_hits_total{resource}: Counter for cache hits
 * - wallet_service_cache_misses_total{resource}: Counter for cache misses
 * - wallet_service_cache_hit_ratio{resource}: Derived gauge (computed via Prometheus rule)
 *
 * Low cardinality: resource label constrained to allowlist to prevent cardinality explosion.
 */

import { Counter } from "prom-client";
import { metricsRegistry } from "@vellar/service-kit";

const ALLOWED_RESOURCES = ["balance", "nonce", "account", "tx-history"] as const;
export type CacheResourceType = (typeof ALLOWED_RESOURCES)[number];

/**
 * Represents a single cache operation result.
 * hit=true + value: cache hit with the cached value.
 * hit=false: cache miss.
 */
export interface CacheGetResult<T = unknown> {
  hit: boolean;
  value?: T;
}

/**
 * Cache storage interface that can be wrapped with metrics.
 */
export interface CacheOperation {
  /**
   * Get a value from the cache by key. Returns { hit: true, value: <T> } on hit,
   * { hit: false } on miss.
   */
  get<T = unknown>(resource: CacheResourceType, key: string): Promise<CacheGetResult<T>>;

  /**
   * Set a value in the cache. May overwrite an existing key.
   */
  set<T = unknown>(resource: CacheResourceType, key: string, value: T): Promise<void>;

  /**
   * Delete a key from the cache. No-op if key doesn't exist.
   */
  delete(resource: CacheResourceType, key: string): Promise<void>;
}

// --- Metric definitions --------------------------------------------------------

const cacheHits = new Counter({
  name: "wallet_service_cache_hits_total",
  help: "Total cache hits for wallet-service by resource type",
  labelNames: ["resource"] as const,
  registers: [metricsRegistry()],
});

const cacheMisses = new Counter({
  name: "wallet_service_cache_misses_total",
  help: "Total cache misses for wallet-service by resource type",
  labelNames: ["resource"] as const,
  registers: [metricsRegistry()],
});

// --- Utility functions ---------------------------------------------------------

/**
 * Validate and normalize a resource label. Maps unknown resources to "unknown"
 * to prevent cardinality explosion.
 */
export function validateResourceLabel(resource: string): CacheResourceType | "unknown" {
  if (ALLOWED_RESOURCES.includes(resource as CacheResourceType)) {
    return resource as CacheResourceType;
  }
  return "unknown";
}

// --- Cache wrapper with metrics ------------------------------------------------

/**
 * Wraps a cache storage implementation and instruments it with Prometheus metrics.
 * Increments counters on every get operation (hit or miss); set/delete are passed through.
 *
 * Metrics are incremented synchronously and non-blocking. If metric recording fails,
 * it is silently dropped (best-effort) so cache operations always succeed.
 */
export function createCacheMetricsWrapper(cache: CacheOperation): CacheOperation {
  return {
    async get<T = unknown>(resource: CacheResourceType, key: string): Promise<CacheGetResult<T>> {
      const result = await cache.get<T>(resource, key);

      // Normalize resource label and increment appropriate counter
      const normalizedResource = validateResourceLabel(resource);

      try {
        if (result.hit) {
          cacheHits.inc({ resource: normalizedResource });
        } else {
          cacheMisses.inc({ resource: normalizedResource });
        }
      } catch (err) {
        // Metric recording must be best-effort and non-blocking; silently drop errors
        // so cache misses or backend failures in the metrics layer never break cache ops.
        // In production, consider logging this via a logger if available.
      }

      return result;
    },

    async set<T = unknown>(
      resource: CacheResourceType,
      key: string,
      value: T,
    ): Promise<void> {
      return cache.set(resource, key, value);
    },

    async delete(resource: CacheResourceType, key: string): Promise<void> {
      return cache.delete(resource, key);
    },
  };
}

// --- Metric exports for observability documentation ---------------------------

export const cacheMetrics = {
  hits: cacheHits,
  misses: cacheMisses,
  allowedResources: ALLOWED_RESOURCES,
} as const;
