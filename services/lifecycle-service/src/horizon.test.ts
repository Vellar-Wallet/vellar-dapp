import { describe, expect, it, vi } from "vitest";
import {
  assertCompleteAccountPagination,
  createHorizonAccountReader,
  HorizonPaginationError,
} from "./horizon";
import { buildCleanupPlan } from "./planner";

const BASE = "https://horizon.test";
const ACCT = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const DEST = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const accountBody = {
  sequence: "100",
  balances: [{ asset_type: "native", balance: "50.0" }],
  data: { config: "AA==" },
};

function offerPage(records: unknown[], nextHref?: string) {
  return {
    _links: nextHref ? { next: { href: nextHref } } : { next: { href: "" } },
    _embedded: { records },
  };
}

function trustlinePage(records: unknown[], nextHref?: string) {
  return {
    _links: nextHref ? { next: { href: nextHref } } : { next: { href: "" } },
    _embedded: { records },
  };
}

function trustlineRecord(index: number, balance = "10.0") {
  return {
    asset_type: "credit_alphanum4",
    asset_code: `T${String(index).padStart(3, "0")}`,
    asset_issuer: DEST,
    balance,
  };
}

function offerRecord(id: string) {
  return {
    id,
    selling: { asset_type: "native" },
    buying: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ACCT },
    price: "1.0",
  };
}

describe("createHorizonAccountReader", () => {
  it("returns undefined for a 404 account", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const reader = createHorizonAccountReader(BASE, { fetchImpl });
    expect(await reader.getAccount(ACCT)).toBeUndefined();
  });

  it("throws on a non-ok account response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const reader = createHorizonAccountReader(BASE, { fetchImpl });
    await expect(reader.getAccount(ACCT)).rejects.toThrow(/account fetch failed/i);
  });

  it("rejects a malformed account body with a clear error, not a TypeError", async () => {
    // Missing balances/sequence: the old `as`-cast would blow up later with a
    // cryptic `.map of undefined`; runtime validation must fail explicitly.
    const fetchImpl = vi.fn(async () => jsonResponse({ nonsense: true }));
    const reader = createHorizonAccountReader(BASE, { fetchImpl });
    await expect(reader.getAccount(ACCT)).rejects.toThrow(/horizon/i);
  });

  it("follows _links.next to collect offers across ALL pages (L6)", async () => {
    const page1 = offerPage(
      [offerRecord("1"), offerRecord("2")],
      `${BASE}/accounts/${ACCT}/offers?cursor=2&limit=200`,
    );
    const page2 = offerPage([offerRecord("3")]); // no next -> last page
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/offers")) {
        return jsonResponse(url.includes("cursor=2") ? page2 : page1);
      }
      return jsonResponse(accountBody);
    });
    const reader = createHorizonAccountReader(BASE, { fetchImpl });
    const account = await reader.getAccount(ACCT);
    expect(account?.offers.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(account?.openOffers).toBe(3);
  });

  it("stops paginating when a page returns no records (guards a self-referential next)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/offers")) {
        // Always advertises a next link but returns an empty page — must not loop.
        return jsonResponse(offerPage([], `${BASE}/accounts/${ACCT}/offers?cursor=x`));
      }
      return jsonResponse(accountBody);
    });
    const reader = createHorizonAccountReader(BASE, { fetchImpl });
    const account = await reader.getAccount(ACCT);
    expect(account?.offers).toEqual([]);
  });

  it("aborts a hung request via the configured timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const reader = createHorizonAccountReader(BASE, { fetchImpl, timeoutMs: 5 });
    await expect(reader.getAccount(ACCT)).rejects.toThrow();
  });

  describe("trustline pagination (#531)", () => {
    it("paginates through all pages for an account with pageSize + 1 trustlines before building a cleanup plan", async () => {
      const pageSize = 3;
      const firstPageTrustlines = [trustlineRecord(1), trustlineRecord(2), trustlineRecord(3)];
      const overflowTrustline = trustlineRecord(4); // pageSize + 1

      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) {
          return jsonResponse(offerPage([]));
        }
        if (url.includes("/trustlines")) {
          return jsonResponse(trustlinePage([overflowTrustline]));
        }
        return jsonResponse({
          sequence: "100",
          balances: [{ asset_type: "native", balance: "50.0" }, ...firstPageTrustlines],
          data: {},
          _links: {
            trustlines: { href: `${BASE}/accounts/${ACCT}/trustlines?cursor=3&limit=${pageSize}` },
          },
        });
      });

      const reader = createHorizonAccountReader(BASE, {
        fetchImpl,
        trustlinePageSize: pageSize,
        retryOptions: { maxAttempts: 1 },
      });

      const account = await reader.getAccount(ACCT);
      expect(account).toBeDefined();
      const nonNativeCodes = account!.balances
        .filter((b) => b.assetType !== "native")
        .map((b) => b.assetCode);
      expect(nonNativeCodes).toEqual(["T001", "T002", "T003", "T004"]);

      const plan = buildCleanupPlan(account!, DEST);
      const trustlineBlockers = plan.blockers.filter((b) => b.type === "trustline");
      expect(trustlineBlockers).toHaveLength(pageSize + 1);
    });

    it("aborts with HorizonPaginationError and refuses to build a cleanup plan if trustline pagination fails partway through (#531)", async () => {
      const pageSize = 2;
      const page1Trustlines = [trustlineRecord(1), trustlineRecord(2)];
      const page2Url = `${BASE}/accounts/${ACCT}/trustlines?cursor=2&limit=${pageSize}`;
      const page3Url = `${BASE}/accounts/${ACCT}/trustlines?cursor=3&limit=${pageSize}`;

      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) {
          return jsonResponse(offerPage([]));
        }
        if (url === page2Url) {
          return jsonResponse(trustlinePage([trustlineRecord(3)], page3Url));
        }
        if (url === page3Url) {
          return new Response("upstream failure", { status: 502 });
        }
        return jsonResponse({
          sequence: "100",
          balances: [{ asset_type: "native", balance: "50.0" }, ...page1Trustlines],
          data: {},
          _links: {
            trustlines: { href: page2Url },
          },
        });
      });

      const reader = createHorizonAccountReader(BASE, {
        fetchImpl,
        trustlinePageSize: pageSize,
        retryOptions: { maxAttempts: 1 },
      });

      await expect(reader.getAccount(ACCT)).rejects.toThrow(HorizonPaginationError);
    });

    it("refuses to build a cleanup plan when account pagination is marked incomplete (#531)", () => {
      const incompleteAccount = {
        accountId: ACCT,
        sequence: "100",
        balances: [{ assetType: "native", balance: "50.0" }],
        dataKeys: [],
        offers: [],
        openOffers: 0,
        paginationComplete: false,
        paginationError: "Horizon 502 on trustlines page 2",
      };

      expect(() => assertCompleteAccountPagination(incompleteAccount)).toThrow(
        HorizonPaginationError,
      );
      expect(() => buildCleanupPlan(incompleteAccount, DEST)).toThrow(/pagination was cut short/i);
    });
  });
});
