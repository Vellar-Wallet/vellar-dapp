import { describe, expect, it, vi } from "vitest";
import { createCachedAccountReader } from "./account-cache";
import type { AccountReader, HorizonAccount } from "./horizon";

function fakeClock(startAt = 0) {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function account(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    accountId: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    sequence: "1",
    balances: [{ assetType: "native", balance: "100" }],
    dataKeys: [],
    offers: [],
    openOffers: 0,
    ...overrides,
  };
}

describe("createCachedAccountReader", () => {
  it("serves a cache hit without calling the underlying reader again", async () => {
    const underlying: AccountReader = { getAccount: vi.fn().mockResolvedValue(account()) };
    const cached = createCachedAccountReader(underlying);

    const first = await cached.getAccount("GAAA");
    const second = await cached.getAccount("GAAA");

    expect(first).toEqual(second);
    expect(underlying.getAccount).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    const clock = fakeClock();
    const underlying: AccountReader = { getAccount: vi.fn().mockResolvedValue(account()) };
    const cached = createCachedAccountReader(underlying, { ttlMs: 1_000, now: clock.now });

    await cached.getAccount("GAAA");
    clock.advance(999);
    await cached.getAccount("GAAA");
    expect(underlying.getAccount).toHaveBeenCalledTimes(1); // still within TTL

    clock.advance(2); // now past the 1000ms TTL
    await cached.getAccount("GAAA");
    expect(underlying.getAccount).toHaveBeenCalledTimes(2);
  });

  it("caches a not-found (undefined) result too", async () => {
    const underlying: AccountReader = { getAccount: vi.fn().mockResolvedValue(undefined) };
    const cached = createCachedAccountReader(underlying);

    expect(await cached.getAccount("GNOTFOUND")).toBeUndefined();
    expect(await cached.getAccount("GNOTFOUND")).toBeUndefined();
    expect(underlying.getAccount).toHaveBeenCalledTimes(1);
  });

  it("caches each account id independently", async () => {
    const underlying: AccountReader = {
      getAccount: vi.fn(async (id: string) => account({ accountId: id })),
    };
    const cached = createCachedAccountReader(underlying);

    await cached.getAccount("GONE");
    await cached.getAccount("GTWO");
    await cached.getAccount("GONE");
    await cached.getAccount("GTWO");

    expect(underlying.getAccount).toHaveBeenCalledTimes(2); // one fetch per distinct id
  });

  describe("invalidate (#287: cache invalidation after account merge)", () => {
    it("forces the next read to go back to the underlying reader", async () => {
      const underlying: AccountReader = { getAccount: vi.fn().mockResolvedValue(account()) };
      const cached = createCachedAccountReader(underlying);

      await cached.getAccount("GSOURCE");
      cached.invalidate("GSOURCE");
      await cached.getAccount("GSOURCE");

      expect(underlying.getAccount).toHaveBeenCalledTimes(2);
    });

    it("reflects a merged account's post-merge state after invalidation", async () => {
      // Simulates the real scenario: a stale cache entry says the source
      // account still exists with its pre-merge balance; after invalidate,
      // the next read reflects that it's gone (merged away) and the
      // destination reflects its new, higher balance.
      let sourceExists = true;
      let destBalance = "50";
      const underlying: AccountReader = {
        getAccount: async (id) => {
          if (id === "GSOURCE") return sourceExists ? account({ accountId: "GSOURCE" }) : undefined;
          if (id === "GDEST") return account({ accountId: "GDEST", balances: [{ assetType: "native", balance: destBalance }] });
          return undefined;
        },
      };
      const cached = createCachedAccountReader(underlying);

      // Pre-merge reads populate the cache with the OLD state.
      expect(await cached.getAccount("GSOURCE")).toBeDefined();
      expect((await cached.getAccount("GDEST"))?.balances[0]?.balance).toBe("50");

      // The merge happens: source disappears, destination's balance grows.
      sourceExists = false;
      destBalance = "150";

      // Without invalidation, both reads would still be stale (within TTL).
      expect(await cached.getAccount("GSOURCE")).toBeDefined(); // still cached, stale
      expect((await cached.getAccount("GDEST"))?.balances[0]?.balance).toBe("50"); // still cached, stale

      // Invalidate both — exactly what POST /lifecycle/merge does.
      cached.invalidate("GSOURCE");
      cached.invalidate("GDEST");

      expect(await cached.getAccount("GSOURCE")).toBeUndefined(); // now correctly gone
      expect((await cached.getAccount("GDEST"))?.balances[0]?.balance).toBe("150"); // now correct
    });

    it("is a no-op for an account id that was never cached", async () => {
      const underlying: AccountReader = { getAccount: vi.fn().mockResolvedValue(account()) };
      const cached = createCachedAccountReader(underlying);

      expect(() => cached.invalidate("GNEVER_CACHED")).not.toThrow();
      await cached.getAccount("GNEVER_CACHED");
      expect(underlying.getAccount).toHaveBeenCalledTimes(1); // unaffected by the earlier invalidate
    });

    it("invalidating one account does not affect another's cached entry", async () => {
      const underlying: AccountReader = {
        getAccount: vi.fn(async (id: string) => account({ accountId: id })),
      };
      const cached = createCachedAccountReader(underlying);

      await cached.getAccount("GONE");
      await cached.getAccount("GTWO");
      cached.invalidate("GONE");

      await cached.getAccount("GONE"); // re-fetched
      await cached.getAccount("GTWO"); // still cached

      expect(underlying.getAccount).toHaveBeenCalledTimes(3); // GONE, GTWO, GONE again
    });
  });

  describe("invalidateAll", () => {
    it("clears every cached entry", async () => {
      const underlying: AccountReader = {
        getAccount: vi.fn(async (id: string) => account({ accountId: id })),
      };
      const cached = createCachedAccountReader(underlying);

      await cached.getAccount("GONE");
      await cached.getAccount("GTWO");
      cached.invalidateAll();
      await cached.getAccount("GONE");
      await cached.getAccount("GTWO");

      expect(underlying.getAccount).toHaveBeenCalledTimes(4);
    });
  });
});
