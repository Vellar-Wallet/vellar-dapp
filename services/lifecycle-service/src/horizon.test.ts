import { describe, expect, it, vi } from "vitest";
import { createHorizonAccountReader } from "./horizon";

const BASE = "https://horizon.test";
const ACCT = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

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
    it("paginates through all trustline pages covering an account with exactly one more trustline than fits on a single page", async () => {
      // Single page has 10 trustlines (page 1) + 1 native balance
      // Page 2 has exactly 1 more trustline (total 11 trustlines)
      const page1Trustlines = Array.from({ length: 10 }, (_, i) => ({
        asset_type: "credit_alphanum4",
        asset_code: `T${i}`,
        asset_issuer: ACCT,
        balance: "10.0",
      }));
      const accountWithPagedBalances = {
        sequence: "100",
        balances: [{ asset_type: "native", balance: "50.0" }, ...page1Trustlines],
        data: {},
        _links: {
          next: { href: `${BASE}/accounts/${ACCT}/balances?cursor=10` },
        },
      };
      const page2Balances = {
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "T10",
            asset_issuer: ACCT,
            balance: "10.0",
          },
        ],
        _links: { next: { href: "" } },
      };

      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) {
          return jsonResponse(offerPage([]));
        }
        if (url.includes("cursor=10")) {
          return jsonResponse(page2Balances);
        }
        return jsonResponse(accountWithPagedBalances);
      });

      const reader = createHorizonAccountReader(BASE, { fetchImpl });
      const account = await reader.getAccount(ACCT);

      expect(account).toBeDefined();
      // 1 native + 10 from page 1 + 1 from page 2 = 12 total balances (11 trustlines)
      expect(account?.balances).toHaveLength(12);
      expect(account?.balances.filter((b) => b.assetType !== "native")).toHaveLength(11);
      expect(account?.balances[account.balances.length - 1]?.assetCode).toBe("T10");
    });

    it("safety check: refuses to return account if trustline pagination is cut short by an error partway through", async () => {
      const accountWithPagedBalances = {
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "50.0" },
          { asset_type: "credit_alphanum4", asset_code: "T0", asset_issuer: ACCT, balance: "10.0" },
        ],
        data: {},
        _links: {
          next: { href: `${BASE}/accounts/${ACCT}/balances?cursor=page2` },
        },
      };

      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) {
          return jsonResponse(offerPage([]));
        }
        if (url.includes("cursor=page2")) {
          return new Response("", { status: 500 });
        }
        return jsonResponse(accountWithPagedBalances);
      });

      const reader = createHorizonAccountReader(BASE, {
        fetchImpl,
        retryOptions: { maxAttempts: 1 },
      });

      // Must throw/refuse, not silently return the partial trustline list
      await expect(reader.getAccount(ACCT)).rejects.toThrow(
        /horizon trustlines pagination failed: pagination was cut short/i,
      );
    });

    it("safety check: refuses to return account if a trustline page returns malformed data", async () => {
      const accountWithPagedBalances = {
        sequence: "100",
        balances: [{ asset_type: "native", balance: "50.0" }],
        data: {},
        _links: {
          next: { href: `${BASE}/accounts/${ACCT}/balances?cursor=page2` },
        },
      };

      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) {
          return jsonResponse(offerPage([]));
        }
        if (url.includes("cursor=page2")) {
          return jsonResponse({ nonsense: true });
        }
        return jsonResponse(accountWithPagedBalances);
      });

      const reader = createHorizonAccountReader(BASE, {
        fetchImpl,
        retryOptions: { maxAttempts: 1 },
      });

      await expect(reader.getAccount(ACCT)).rejects.toThrow(
        /horizon trustlines response was malformed/i,
      );
    });
  });
  describe("trustline pagination link returns 404 (#832)", () => {
    // The top-level account fetch maps 404 to "account does not exist". A 404
    // on a *pagination* link is a different thing: the account exists, the
    // link is dead (transient Horizon issue, malformed/expired cursor). It must
    // trip the cut-short safety check — not be read as "no more trustlines",
    // not be reported as a malformed body, and never as account-not-found.
    function pagedAccount(nextHref: string) {
      return {
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "50.0" },
          { asset_type: "credit_alphanum4", asset_code: "T0", asset_issuer: ACCT, balance: "1.0" },
        ],
        data: {},
        _links: { next: { href: nextHref } },
      };
    }

    function trustlinePage(code: string, nextHref?: string) {
      return {
        balances: [
          { asset_type: "credit_alphanum4", asset_code: code, asset_issuer: ACCT, balance: "1.0" },
        ],
        _links: nextHref ? { next: { href: nextHref } } : { next: { href: "" } },
      };
    }

    it("happy path: a fully-resolvable chain of pagination links returns every trustline", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) {
          return jsonResponse(trustlinePage("T1", `${BASE}/accounts/${ACCT}/balances?cursor=p3`));
        }
        if (url.includes("cursor=p3")) return jsonResponse(trustlinePage("T2"));
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const reader = createHorizonAccountReader(BASE, { fetchImpl });
      const account = await reader.getAccount(ACCT);
      expect(account?.balances.map((b) => b.assetCode ?? "native")).toEqual([
        "native",
        "T0",
        "T1",
        "T2",
      ]);
    });

    it("refuses with the cut-short error when the FIRST pagination link 404s", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) return new Response("", { status: 404 });
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const reader = createHorizonAccountReader(BASE, { fetchImpl });

      const attempt = reader.getAccount(ACCT);
      await expect(attempt).rejects.toThrow(
        /horizon trustlines pagination failed: pagination was cut short because trustline page 2 returned 404/i,
      );
      // Specifically the pagination failure mode — not the malformed-body path.
      await expect(reader.getAccount(ACCT)).rejects.not.toThrow(/malformed/i);
    });

    it("refuses when a LATER pagination link 404s after earlier pages succeeded (no partial list)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) {
          return jsonResponse(trustlinePage("T1", `${BASE}/accounts/${ACCT}/balances?cursor=bad`));
        }
        if (url.includes("cursor=bad")) return new Response("", { status: 404 });
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const reader = createHorizonAccountReader(BASE, { fetchImpl });

      await expect(reader.getAccount(ACCT)).rejects.toThrow(
        /pagination was cut short because trustline page 3 returned 404/i,
      );
    });

    it("never maps a pagination 404 to 'account does not exist' (undefined)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) return new Response("", { status: 404 });
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const reader = createHorizonAccountReader(BASE, { fetchImpl });

      const result = await reader.getAccount(ACCT).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(result.ok).toBe(false);
    });

    it("does not follow offers or return data once the trustline link has 404'd", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) return new Response("", { status: 404 });
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const reader = createHorizonAccountReader(BASE, { fetchImpl });

      await expect(reader.getAccount(ACCT)).rejects.toThrow(/cut short/i);
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/offers"))).toBe(false);
    });

    it("a pagination 404 is a different failure from a generic network error, but both refuse", async () => {
      const notFound = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) return new Response("", { status: 404 });
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });
      const networkError = vi.fn(async (url: string) => {
        if (url.includes("/offers")) return jsonResponse(offerPage([]));
        if (url.includes("cursor=p2")) throw new TypeError("fetch failed");
        return jsonResponse(pagedAccount(`${BASE}/accounts/${ACCT}/balances?cursor=p2`));
      });

      const notFoundErr = await createHorizonAccountReader(BASE, { fetchImpl: notFound })
        .getAccount(ACCT)
        .catch((e: Error) => e);
      const networkErr = await createHorizonAccountReader(BASE, {
        fetchImpl: networkError,
        retryOptions: { maxAttempts: 1 },
      })
        .getAccount(ACCT)
        .catch((e: Error) => e);

      expect((notFoundErr as Error).message).toMatch(
        /cut short because trustline page 2 returned 404/,
      );
      expect((networkErr as Error).message).toMatch(/cut short by an error/);
      expect((networkErr as Error).message).not.toMatch(/404/);
    });
  });
});
