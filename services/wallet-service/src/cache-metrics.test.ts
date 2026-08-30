import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCacheMetricsWrapper,
  validateResourceLabel,
  type CacheOperation,
} from "./cache-metrics";
import { metricsRegistry, __resetMetricsForTest } from "@vellar/service-kit";

describe("Cache Metrics", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  describe("validateResourceLabel", () => {
    it("allows known resource types", () => {
      expect(validateResourceLabel("balance")).toBe("balance");
      expect(validateResourceLabel("nonce")).toBe("nonce");
      expect(validateResourceLabel("account")).toBe("account");
      expect(validateResourceLabel("tx-history")).toBe("tx-history");
    });

    it("maps unknown resources to 'unknown'", () => {
      expect(validateResourceLabel("unknown-resource")).toBe("unknown");
      expect(validateResourceLabel("random")).toBe("unknown");
      expect(validateResourceLabel("")).toBe("unknown");
    });
  });

  describe("createCacheMetricsWrapper", () => {
    it("increments hit counter on cache hit", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockResolvedValue({ hit: true, value: "cached-value" }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      const result = await wrapped.get("balance", "key1");

      expect(result).toEqual({ hit: true, value: "cached-value" });

      // Check that metric was incremented
      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_hits_total{resource="balance"} 1');
    });

    it("increments miss counter on cache miss", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockResolvedValue({ hit: false }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      const result = await wrapped.get("nonce", "key1");

      expect(result).toEqual({ hit: false });

      // Check that metric was incremented
      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_misses_total{resource="nonce"} 1');
    });

    it("accumulates hits across multiple calls", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockResolvedValue({ hit: true, value: "data" }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.get("balance", "key1");
      await wrapped.get("balance", "key2");
      await wrapped.get("balance", "key3");

      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_hits_total{resource="balance"} 3');
    });

    it("accumulates misses and hits separately", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn()
          .mockResolvedValueOnce({ hit: true, value: "data" })
          .mockResolvedValueOnce({ hit: false })
          .mockResolvedValueOnce({ hit: true, value: "data" }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.get("account", "key1");
      await wrapped.get("account", "key2");
      await wrapped.get("account", "key3");

      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_hits_total{resource="account"} 2');
      expect(metrics).toContain('wallet_service_cache_misses_total{resource="account"} 1');
    });

    it("maps unknown resources to 'unknown' label", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockResolvedValue({ hit: false }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.get("invalid-resource" as any, "key1");

      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_misses_total{resource="unknown"} 1');
    });

    it("passes through cache set operations unchanged", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn(),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.set("balance", "key1", "value1");

      expect(mockCache.set).toHaveBeenCalledWith("balance", "key1", "value1");
    });

    it("passes through cache delete operations unchanged", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn(),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.delete("nonce", "key1");

      expect(mockCache.delete).toHaveBeenCalledWith("nonce", "key1");
    });

    it("does not crash on metrics registry errors", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockResolvedValue({ hit: true, value: "data" }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      // Should not throw even if metrics is unavailable
      expect(async () => {
        await wrapped.get("balance", "key1");
      }).not.toThrow();
    });

    it("does not interfere with cache operation errors", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn().mockRejectedValue(new Error("Cache backend error")),
        set: vi.fn().mockRejectedValue(new Error("Cache backend error")),
        delete: vi.fn().mockRejectedValue(new Error("Cache backend error")),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await expect(wrapped.get("balance", "key1")).rejects.toThrow("Cache backend error");
    });

    it("tracks hits/misses across different resources independently", async () => {
      const mockCache: CacheOperation = {
        get: vi.fn()
          .mockResolvedValueOnce({ hit: true, value: "data1" }) // balance hit
          .mockResolvedValueOnce({ hit: false }) // nonce miss
          .mockResolvedValueOnce({ hit: true, value: "data2" }) // tx-history hit
          .mockResolvedValueOnce({ hit: false }), // account miss
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const wrapped = createCacheMetricsWrapper(mockCache);

      await wrapped.get("balance", "key1");
      await wrapped.get("nonce", "key2");
      await wrapped.get("tx-history", "key3");
      await wrapped.get("account", "key4");

      const metrics = await metricsRegistry().metrics();
      expect(metrics).toContain('wallet_service_cache_hits_total{resource="balance"} 1');
      expect(metrics).toContain('wallet_service_cache_misses_total{resource="nonce"} 1');
      expect(metrics).toContain('wallet_service_cache_hits_total{resource="tx-history"} 1');
      expect(metrics).toContain('wallet_service_cache_misses_total{resource="account"} 1');
    });
  });
});
