import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULTS, OriginPatternError } from "./config";
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

describe("origin pattern validation at boot", () => {
  it("accepts well-formed glob patterns and returns them", () => {
    const config = configFromEnv({
      PERMISSION_ORIGIN_PATTERNS: "https://app.example.com, https://*.example.com",
    });
    expect(config.originPatterns).toEqual(["https://app.example.com", "https://*.example.com"]);
    expect(config.warnings).toEqual([]);
  });

  it("fails boot with a clear error naming a malformed pattern", () => {
    expect(() =>
      configFromEnv({ PERMISSION_ORIGIN_PATTERNS: "https://app.example.com, https://[invalid" }),
    ).toThrow(OriginPatternError);
    try {
      configFromEnv({ PERMISSION_ORIGIN_PATTERNS: "https://[invalid" });
      expect.unreachable("malformed pattern should fail boot");
    } catch (err) {
      expect(err).toBeInstanceOf(OriginPatternError);
      expect((err as OriginPatternError).pattern).toBe("https://[invalid");
      expect((err as Error).message).toContain("https://[invalid");
    }
  });

  it("warns rather than fails on a pattern that matches nothing", () => {
    const config = configFromEnv({
      PERMISSION_ORIGIN_PATTERNS: "https://app.example.com, , https://other.example.com",
    });
    expect(config.originPatterns).toEqual(["https://app.example.com", "https://other.example.com"]);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain("matches nothing");
  });

  it("returns no patterns and no warnings when none are configured", () => {
    const config = configFromEnv({});
    expect(config.originPatterns).toEqual([]);
    expect(config.warnings).toEqual([]);
  });
});
