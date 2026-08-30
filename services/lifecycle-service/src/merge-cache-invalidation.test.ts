import { describe, expect, it } from "vitest";
import { createCachedAccountReader } from "./account-cache";
import { createNoOpAuditLog } from "./audit";
import type { HorizonAccount } from "./horizon";
import { buildServer } from "./server";

// #287: cache invalidation after account merge, exercised through the real
// POST /lifecycle/merge route (not just account-cache.ts's own unit tests)
// so the actual wiring in server.ts is what's under test.

const SOURCE = "GCZCWI2TXEKYI7AGNNZFTI23KSRLBYSAB3JUKB65SOUHX6TYH5VIGCXO";
const DEST = "GASK2YW5XT2BJCSPQYWTRVRZAZNA5NP7BIWXMW6LOIHIDNEMSUIYHS5U";

function sourceAccount(): HorizonAccount {
  return {
    accountId: SOURCE,
    sequence: "1",
    balances: [{ assetType: "native", balance: "100" }], // no non-native balances -> mergeReady
    dataKeys: [],
    offers: [],
    openOffers: 0,
  };
}

function destAccount(balance: string): HorizonAccount {
  return {
    accountId: DEST,
    sequence: "1",
    balances: [{ assetType: "native", balance }],
    dataKeys: [],
    offers: [],
    openOffers: 0,
  };
}

describe("POST /lifecycle/merge invalidates the cached source and destination accounts (#287)", () => {
  it("evicts both accounts from the cache after a successful merge, so the next read is fresh", async () => {
    let destBalance = "50";
    let sourceStillExists = true;

    const underlying = {
      getAccount: async (id: string) => {
        if (id === SOURCE) return sourceStillExists ? sourceAccount() : undefined;
        if (id === DEST) return destAccount(destBalance);
        return undefined;
      },
    };
    const reader = createCachedAccountReader(underlying);
    const app = buildServer({ reader, auditLog: createNoOpAuditLog() });
    await app.ready();

    try {
      // Populate the cache for both accounts BEFORE the merge (mirrors the
      // real inspect -> plan -> merge workflow, which reads both repeatedly).
      const inspect = await app.inject({
        method: "POST",
        url: "/lifecycle/inspect",
        payload: { accountId: SOURCE },
      });
      expect(inspect.statusCode).toBe(200);
      await reader.getAccount(DEST); // warm the destination's cache entry too

      // The merge completes on-chain (simulated): source is gone, dest's
      // balance grew. The cache doesn't know this yet.
      sourceStillExists = false;
      destBalance = "150";

      // Execute the merge via the real route.
      const mergeRes = await app.inject({
        method: "POST",
        url: "/lifecycle/merge",
        payload: { accountId: SOURCE, destination: DEST },
      });
      expect(mergeRes.statusCode).toBe(200);
      expect(mergeRes.json().step.title).toBe("Merge and close the account");
      expect(mergeRes.json().step.xdr).toEqual(expect.any(String));

      // The route's own handler reads SOURCE fresh (uncached at that point,
      // since it hadn't been re-populated after the merge-eligibility
      // check) — what matters is that its CACHE ENTRY is now gone too, so a
      // caller reading it again afterward gets live data, not the
      // pre-merge cached value from the /inspect call above.
      expect(await reader.getAccount(SOURCE)).toBeUndefined();
      expect((await reader.getAccount(DEST))?.balances[0]?.balance).toBe("150");
    } finally {
      await app.close();
    }
  });

  it("does not attempt invalidation (and does not throw) when the reader has no cache", async () => {
    // A plain AccountReader (no invalidate method) — the common case in
    // most other tests in this package, and for any deployment that
    // disables caching. The merge route must work identically either way.
    const plainReader = {
      getAccount: async (id: string) => (id === SOURCE ? sourceAccount() : destAccount("50")),
    };
    const app = buildServer({ reader: plainReader, auditLog: createNoOpAuditLog() });
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/lifecycle/merge",
        payload: { accountId: SOURCE, destination: DEST },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not invalidate anything when the merge is rejected for having blockers", async () => {
    const blockedAccount: HorizonAccount = {
      accountId: SOURCE,
      sequence: "1",
      balances: [
        { assetType: "native", balance: "100" },
        { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: DEST, balance: "5" },
      ],
      dataKeys: [],
      offers: [],
      openOffers: 0,
    };
    let calls = 0;
    const underlying = {
      getAccount: async (id: string) => {
        calls++;
        return id === SOURCE ? blockedAccount : destAccount("50");
      },
    };
    const reader = createCachedAccountReader(underlying);
    const app = buildServer({ reader, auditLog: createNoOpAuditLog() });
    await app.ready();

    try {
      await reader.getAccount(SOURCE); // populate the cache
      expect(calls).toBe(1);

      const res = await app.inject({
        method: "POST",
        url: "/lifecycle/merge",
        payload: { accountId: SOURCE, destination: DEST },
      });
      expect(res.statusCode).toBe(409);

      // Still cached — the rejected merge must not have evicted anything,
      // since nothing was actually committed to. The route's own
      // account-lookup during the merge attempt is a real underlying call
      // (it doesn't share the pre-warmed cache read above in this test's
      // setup), but a SECOND read after the rejection must come from cache,
      // not a third underlying call.
      const callsAfterMergeAttempt = calls;
      await reader.getAccount(SOURCE);
      expect(calls).toBe(callsAfterMergeAttempt); // no new underlying call — served from cache
    } finally {
      await app.close();
    }
  });
});
