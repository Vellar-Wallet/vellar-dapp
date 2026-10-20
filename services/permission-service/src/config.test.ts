import { describe, expect, it, vi } from "vitest";
import {
  configFromEnv,
  DEFAULTS,
  matchesAllowedOrigin,
  OriginPatternConfigError,
  validateOriginPatterns,
} from "./config";
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

describe("permission-service boot-time origin pattern validation (#548)", () => {
  it("accepts valid exact, subdomain-wildcard, and regex origin patterns without warnings", () => {
    const onWarn = vi.fn();
    const config = configFromEnv(
      {
        PERMISSION_ALLOWED_ORIGIN_PATTERNS:
          "https://app.vellar.xyz, https://*.vellar.xyz, http://localhost:3000, /^https:\\/\\/preview-[0-9]+\\.vellar\\.xyz$/",
      },
      { onWarn },
    );

    expect(config.originPatternWarnings).toEqual([]);
    expect(onWarn).not.toHaveBeenCalled();
    expect(config.allowedOriginPatterns).toHaveLength(4);

    expect(matchesAllowedOrigin("https://app.vellar.xyz", config.allowedOriginPatterns)).toBe(true);
    expect(matchesAllowedOrigin("https://swap.vellar.xyz", config.allowedOriginPatterns)).toBe(
      true,
    );
    expect(matchesAllowedOrigin("http://localhost:3000", config.allowedOriginPatterns)).toBe(true);
    expect(
      matchesAllowedOrigin("https://preview-42.vellar.xyz", config.allowedOriginPatterns),
    ).toBe(true);
    expect(matchesAllowedOrigin("https://evil.example.com", config.allowedOriginPatterns)).toBe(
      false,
    );
  });

  it("fails boot with OriginPatternConfigError naming the offending malformed pattern", () => {
    const malformedCases = [
      "https://app.vellar.xyz/extra-path",
      "ftp://app.vellar.xyz",
      "https://*vellar.xyz",
      "*",
      "/^https:\\/\\/([unclosed/",
    ];

    for (const badPattern of malformedCases) {
      let caught: unknown;
      try {
        configFromEnv({
          PERMISSION_ALLOWED_ORIGIN_PATTERNS: `https://app.vellar.xyz, ${badPattern}`,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OriginPatternConfigError);
      expect((caught as OriginPatternConfigError).pattern.trim()).toBe(badPattern);
      expect((caught as Error).message).toContain(badPattern);
    }
  });

  it("flags syntactically valid patterns that match nothing as warnings without failing boot", () => {
    const onWarn = vi.fn();
    const { patterns, warnings } = validateOriginPatterns(
      ["https://app.vellar.xyz", "/(?!)/", "/^$/", "https://*.127.0.0.1"],
      { onWarn },
    );

    expect(patterns).toHaveLength(4);
    expect(warnings).toHaveLength(3);
    expect(onWarn).toHaveBeenCalledTimes(3);
    expect(warnings.map((w) => w.pattern)).toEqual(["/(?!)/", "/^$/", "https://*.127.0.0.1"]);

    expect(matchesAllowedOrigin("https://app.vellar.xyz", patterns)).toBe(true);
    expect(matchesAllowedOrigin("https://sub.127.0.0.1", patterns)).toBe(false);
  });
});
