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
          if (id === "GDEST")
            return account({
              accountId: "GDEST",
              balances: [{ assetType: "native", balance: destBalance }],
            });
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

  describe("mid-TTL account closure (#532)", () => {
    it("does not serve a stale closed-account entry after invalidation when account is closed mid-TTL", async () => {
      let accountOnChain: HorizonAccount | undefined = account({ accountId: "GCLOSED" });
      const underlying: AccountReader = {
        getAccount: vi.fn(async (id: string) => (id === "GCLOSED" ? accountOnChain : undefined)),
      };
      const cached = createCachedAccountReader(underlying);

      // 1. Initial read while open: cached entry is populated
      const initial = await cached.getAccount("GCLOSED");
      expect(initial).toBeDefined();
      expect(initial?.accountId).toBe("GCLOSED");
      expect(underlying.getAccount).toHaveBeenCalledTimes(1);

      // 2. Account is closed on-chain mid-TTL (merged away by external actor)
      accountOnChain = undefined;

      // 3. Invalidate the cached account entry
      cached.invalidate("GCLOSED");

      // 4. Assert the cache does NOT serve a stale closed-account entry as if the account were still open
      const afterClosure = await cached.getAccount("GCLOSED");
      expect(afterClosure).toBeUndefined();
      expect(underlying.getAccount).toHaveBeenCalledTimes(2);

      // 5. Subsequent read serves the cached undefined (closed) without hitting underlying reader
      const subsequent = await cached.getAccount("GCLOSED");
      expect(subsequent).toBeUndefined();
      expect(underlying.getAccount).toHaveBeenCalledTimes(2);
    });

    it.each(["invalidate", "invalidateAll"] as const)(
      "prevents reads started before %s from caching the open account",
      async (method) => {
        const openAccount = account({ accountId: "GCLOSED" });
        let resolveFirst!: (value: HorizonAccount) => void;
        let resolveSecond!: (value: HorizonAccount) => void;
        const firstRead = new Promise<HorizonAccount>((resolve) => {
          resolveFirst = resolve;
        });
        const secondRead = new Promise<HorizonAccount>((resolve) => {
          resolveSecond = resolve;
        });
        const getAccount = vi
          .fn<AccountReader["getAccount"]>()
          .mockReturnValueOnce(firstRead)
          .mockReturnValueOnce(secondRead)
          .mockResolvedValue(undefined);
        const cached = createCachedAccountReader({ getAccount });
        const first = cached.getAccount(openAccount.accountId);
        const second = cached.getAccount(openAccount.accountId);

        if (method === "invalidate") cached.invalidate(openAccount.accountId);
        else cached.invalidateAll();

        resolveFirst(openAccount);
        expect(await first).toEqual(openAccount);
        expect(await cached.getAccount(openAccount.accountId)).toBeUndefined();

        resolveSecond(openAccount);
        expect(await second).toEqual(openAccount);
        expect(await cached.getAccount(openAccount.accountId)).toBeUndefined();
        expect(getAccount).toHaveBeenCalledTimes(3);
      },
    );

    it("re-evaluates closed account after TTL expires without manual invalidation", async () => {
      const clock = fakeClock();
      let accountOnChain: HorizonAccount | undefined = account({ accountId: "GCLOSED_TTL" });
      const underlying: AccountReader = {
        getAccount: vi.fn(async (id: string) =>
          id === "GCLOSED_TTL" ? accountOnChain : undefined,
        ),
      };
      const cached = createCachedAccountReader(underlying, { ttlMs: 1_000, now: clock.now });

      // Warm cache while open
      expect(await cached.getAccount("GCLOSED_TTL")).toBeDefined();

      // Account is closed externally mid-TTL
      accountOnChain = undefined;

      // Within TTL: still served from cache
      clock.advance(500);
      expect(await cached.getAccount("GCLOSED_TTL")).toBeDefined();
      expect(underlying.getAccount).toHaveBeenCalledTimes(1);

      // Past TTL: cache re-fetches and detects the account is closed (undefined)
      clock.advance(501);
      const afterExpiry = await cached.getAccount("GCLOSED_TTL");
      expect(afterExpiry).toBeUndefined();
      expect(underlying.getAccount).toHaveBeenCalledTimes(2);

      // Cached undefined is now retained
      expect(await cached.getAccount("GCLOSED_TTL")).toBeUndefined();
      expect(underlying.getAccount).toHaveBeenCalledTimes(2);
    });
  });
});
