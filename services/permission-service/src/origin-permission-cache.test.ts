import { describe, expect, it } from "vitest";
import { createRevocationInvalidationHook, OriginPermissionCache } from "./origin-permission-cache";

describe("OriginPermissionCache — revocation invalidation hook (#547)", () => {
  it("evicts a cached origin on revocation (cache hit -> invalidate -> cache miss)", () => {
    let now = 1_000;
    const cache = new OriginPermissionCache<{ allowed: boolean }>({
      ttlMs: 60_000,
      now: () => now,
    });
    const onExtensionRevoke = createRevocationInvalidationHook(cache);

    cache.set("https://app.vellar.xyz", { allowed: true });
    expect(cache.get("https://app.vellar.xyz")).toEqual({ allowed: true });

    const result = onExtensionRevoke({
      origin: "https://app.vellar.xyz",
      accountId: "GABC123",
      network: "testnet",
      revokedAt: "2026-10-18T00:00:00.000Z",
    });

    expect(result).toEqual({
      origin: "https://app.vellar.xyz",
      normalizedOrigin: "https://app.vellar.xyz",
      invalidated: true,
    });
    expect(cache.get("https://app.vellar.xyz")).toBeUndefined();
  });

  it("treats invalidating an uncached or already-expired entry as a safe no-op", () => {
    let now = 5_000;
    const cache = new OriginPermissionCache<boolean>({
      ttlMs: 1_000,
      now: () => now,
    });
    const onExtensionRevoke = createRevocationInvalidationHook(cache);

    // Never cached
    expect(cache.invalidate("https://uncached.vellar.xyz")).toBe(false);
    expect(onExtensionRevoke("https://uncached.vellar.xyz")).toEqual({
      origin: "https://uncached.vellar.xyz",
      normalizedOrigin: "https://uncached.vellar.xyz",
      invalidated: false,
    });

    // Cached, then expired before revocation arrives
    cache.set("https://expired.vellar.xyz", true);
    now += 1_500;
    expect(onExtensionRevoke({ origin: "https://expired.vellar.xyz" })).toEqual({
      origin: "https://expired.vellar.xyz",
      normalizedOrigin: "https://expired.vellar.xyz",
      invalidated: false,
    });
    expect(cache.get("https://expired.vellar.xyz")).toBeUndefined();
  });

  it("normalizes origin casing and trailing FQDN dot when invalidating", () => {
    const cache = new OriginPermissionCache<boolean>({ ttlMs: 30_000 });
    cache.set("https://app.vellar.xyz", true);

    const res = cache.onRevoke({ origin: "HTTPS://APP.VELLAR.XYZ." });
    expect(res.invalidated).toBe(true);
    expect(res.normalizedOrigin).toBe("https://app.vellar.xyz");
    expect(cache.get("https://app.vellar.xyz")).toBeUndefined();
  });
});
