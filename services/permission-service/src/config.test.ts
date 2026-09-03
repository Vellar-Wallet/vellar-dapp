import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULTS } from "./config";
import { OriginPermissionCache } from "./origin-permission-cache";

describe("permission-service cache configuration", () => {
  it("uses the default TTL when it is not configured", () => {
    expect(configFromEnv({}).originPermissionCacheTtlMs).toBe(DEFAULTS.originPermissionCacheTtlMs);
  });

  it("respects the configured TTL", () => {
    let now = 10_000;
    const config = configFromEnv({ PERMISSION_CACHE_TTL_MS: "2500" });
    const cache = new OriginPermissionCache({
      ttlMs: config.originPermissionCacheTtlMs,
      now: () => now,
    });

    cache.set("https://example.test", true);
    now += 2499;
    expect(cache.get("https://example.test")).toBe(true);
    now += 1;
    expect(cache.get("https://example.test")).toBeUndefined();
  });

  it("falls back for values outside the documented range", () => {
    expect(configFromEnv({ PERMISSION_CACHE_TTL_MS: "500" }).originPermissionCacheTtlMs).toBe(
      DEFAULTS.originPermissionCacheTtlMs,
    );
    expect(configFromEnv({ PERMISSION_CACHE_TTL_MS: "86400001" }).originPermissionCacheTtlMs).toBe(
      DEFAULTS.originPermissionCacheTtlMs,
    );
  });
});
