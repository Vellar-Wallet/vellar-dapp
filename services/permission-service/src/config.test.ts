import { describe, expect, it } from "vitest";
import {
  compileOriginPattern,
  configFromEnv,
  DEFAULTS,
  matchesOriginPattern,
  MAX_ORIGIN_LENGTH,
  OriginPatternError,
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

describe("origin patterns: catastrophic-backtracking (ReDoS) boot validation (#840)", () => {
  it("happy path: ordinary exact and wildcard origin patterns still boot", () => {
    const config = configFromEnv({
      PERMISSION_ORIGIN_PATTERNS:
        "https://app.example.com, https://*.example.com, https://*.*.example.com, http://localhost:[0-9]{4}",
    });
    expect(config.originPatterns).toEqual([
      "https://app.example.com",
      "https://*.example.com",
      "https://*.*.example.com",
      "http://localhost:[0-9]{4}",
    ]);
  });

  it("happy path: a validated pattern matches real origins quickly at runtime", () => {
    const re = compileOriginPattern("https://*.example.com");
    expect(matchesOriginPattern(re, "https://app.example.com")).toBe(true);
    expect(matchesOriginPattern(re, "https://example.org")).toBe(false);
  });

  // NB: in this glob syntax a bare `*` is the wildcard (`.*`), not a repeat of
  // the preceding token, so group repetition is spelled `+` or `{n,}` here.
  it.each([
    ["nested quantifier (a+)+", "https://(a+)+.example.com", /nested quantifier/],
    ["nested quantifier via glob (*)+", "https://(*)+.example.com", /nested quantifier/],
    ["nested repeated label ([a-z]+\\.)+", "https://([a-z]+\\.)+example.com", /nested quantifier/],
    ["nested bounded quantifiers", "https://(?:a{1,20}){1,20}.example.com", /nested quantifier/],
    ["deeply nested ((a+))+", "https://((a+))+.example.com", /nested quantifier/],
    ["overlapping alternation (a|a)+", "https://(a|a)+.example.com", /quantified alternation/],
    ["alternation repeated with {n,}", "https://(a|ab){2,}.example.com", /quantified alternation/],
    ["backreference", "https://(a)\\1.example.com", /backreferences/],
    ["three glob wildcards", "https://*.*.*.example.com", /unbounded wildcards/],
    ["mixed unbounded quantifiers", "https://a+b+.*.example.com", /unbounded wildcards/],
  ])("refuses a syntactically valid but dangerous pattern: %s", (_label, pattern, why) => {
    // It IS valid regex syntax — the old boot check would have let it through.
    expect(() => new RegExp(`^${pattern.replace(/\*/g, ".*")}$`)).not.toThrow();
    expect(() => compileOriginPattern(pattern)).toThrow(OriginPatternError);
    expect(() => compileOriginPattern(pattern)).toThrow(why);
    expect(() => compileOriginPattern(pattern)).toThrow(/ReDoS/);
  });

  it("fails boot from env and names the offending pattern", () => {
    let caught: unknown;
    try {
      configFromEnv({ PERMISSION_ORIGIN_PATTERNS: "https://app.example.com, https://(a+)+.evil" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OriginPatternError);
    expect((caught as OriginPatternError).pattern).toBe("https://(a+)+.evil");
    expect((caught as Error).message).toContain("https://(a+)+.evil");
  });

  it("time-boxed probe catches a slow pattern the static scan does not model", () => {
    // Only BOUNDED quantifiers and no nesting, so the shape rules pass it — but
    // four overlapping {0,600} runs are O(n^4) on a near-miss input.
    const pattern = "a{0,600}a{0,600}a{0,600}a{0,600}";
    const started = Date.now();
    expect(() => compileOriginPattern(pattern)).toThrow(/crafted \d+-char input exceeded/);
    // The probe is interrupted, it does not hang boot.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not throw for safe patterns that only contain non-repeating quantifiers", () => {
    expect(() => compileOriginPattern("https://(app|www)?.example.com")).not.toThrow();
    expect(() => compileOriginPattern("https://app.example.com(:443)?")).not.toThrow();
    expect(() => compileOriginPattern("https://[a-z+*]{3}.example.com")).not.toThrow();
  });

  it("validateOriginPatterns still treats empty patterns as warnings, not ReDoS failures", () => {
    expect(validateOriginPatterns(["  ", "https://*.example.com"])).toEqual({
      valid: ["https://*.example.com"],
      warnings: ['origin pattern "  " matches nothing and is ignored'],
    });
  });

  it("runtime matcher refuses (fail-closed) an origin longer than the probed bound", () => {
    const re = compileOriginPattern("https://*.example.com");
    const huge = `https://${"a".repeat(MAX_ORIGIN_LENGTH)}.example.com`;
    expect(re.test(huge)).toBe(true); // the regex alone would accept it…
    expect(matchesOriginPattern(re, huge)).toBe(false); // …the bounded matcher does not
  });

  it("an allowed 2-wildcard pattern stays fast on a worst-case near-miss input", () => {
    const re = compileOriginPattern("https://*.*.example.com");
    const nearMiss = `https://${".".repeat(MAX_ORIGIN_LENGTH - 9)}!`;
    const started = Date.now();
    expect(matchesOriginPattern(re, nearMiss)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
