import { describe, expect, it, vi } from "vitest";
import { FacilitatorClient } from "./facilitator";
import { FacilitatorError } from "./errors";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: unknown) {
  return new FacilitatorClient({
    baseUrl: "https://facilitator.test/",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe("FacilitatorClient", () => {
  it("strips a trailing slash from the base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    await client(fetchImpl).getResources({ limit: 5 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://facilitator.test/discovery/resources?limit=5",
    );
  });

  it.each([
    ["items", { items: [{ resource: "https://a.test/x" }] }],
    ["resources", { resources: [{ resource: "https://a.test/x" }] }],
    ["data", { data: [{ resource: "https://a.test/x" }] }],
  ])("accepts the %s list envelope", async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const result = await client(fetchImpl).getResources({});
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.resourceUrl).toBe("https://a.test/x");
  });

  it.each([
    ["resource", { resource: "https://a.test/x" }],
    ["resourceUrl", { resourceUrl: "https://a.test/x" }],
    ["url", { url: "https://a.test/x" }],
  ])("reads the resource URL from %s", async (_label, entry) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [entry] }));
    const { resources } = await client(fetchImpl).getResources({});
    expect(resources[0]?.resourceUrl).toBe("https://a.test/x");
  });

  it.each([
    ["price", { resource: "u", price: "500" }],
    ["amount", { resource: "u", amount: "500" }],
    ["maxAmountRequired", { resource: "u", maxAmountRequired: "500" }],
    ["a numeric price", { resource: "u", price: 500 }],
  ])("normalizes the amount from %s", async (_label, entry) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [entry] }));
    const { resources } = await client(fetchImpl).getResources({});
    expect(resources[0]?.priceAtomic).toBe("500");
  });

  // Locks in the shape the LIVE facilitator actually serves — captured from
  // vellar-facilitator.onrender.com/discovery/resources on 2026-09-12. x402 v2
  // nests payment details inside accepts[], not at the top level.
  it("normalizes a real x402 v2 entry with a nested accepts[] array", async () => {
    const live = {
      x402Version: 2,
      items: [
        {
          resource: "https://vellar-seller-demo.onrender.com/lorem",
          type: "http",
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "stellar:testnet",
              asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
              amount: "100000",
              payTo: "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
              maxTimeoutSeconds: 120,
              extra: { areFeesSponsored: true },
            },
          ],
          lastUpdated: "2026-09-08T15:39:17.726Z",
          description: "Generate placeholder lorem ipsum text.",
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, live));
    const { resources } = await client(fetchImpl).getResources({});
    expect(resources[0]).toMatchObject({
      resourceUrl: "https://vellar-seller-demo.onrender.com/lorem",
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      priceAtomic: "100000",
      payTo: "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
      areFeesSponsored: true,
    });
  });

  it("prefers a top-level amount when there is no accepts[]", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [{ resource: "u", amount: "7", asset: "A" }] }));
    const { resources } = await client(fetchImpl).getResources({});
    expect(resources[0]).toMatchObject({ priceAtomic: "7", asset: "A" });
  });

  it("prefers nextCursor but falls back to next", async () => {
    const withNext = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], next: "n1" }));
    expect((await client(withNext).getResources({})).nextCursor).toBe("n1");
    const withCursor = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [], nextCursor: "n2", next: "n1" }));
    expect((await client(withCursor).getResources({})).nextCursor).toBe("n2");
  });

  it("sends the search query as ?query=", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    await client(fetchImpl).searchResources("cheap weather", 3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://facilitator.test/discovery/search?query=cheap+weather&limit=3",
    );
  });

  it("reports partialResults when the upstream flags it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [], partialResults: true }));
    expect((await client(fetchImpl).searchResources("x")).partialResults).toBe(true);
  });

  it("matches getResource on an EXACT url, never a prefix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { items: [{ resource: "https://a.test/paid" }] }),
    );
    const c = client(fetchImpl);
    await expect(c.getResource("https://a.test/paid")).resolves.toMatchObject({
      resourceUrl: "https://a.test/paid",
    });
    await expect(c.getResource("https://a.test/pai")).rejects.toBeInstanceOf(FacilitatorError);
  });

  it("raises a 404-status FacilitatorError for an unknown resource", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    await expect(client(fetchImpl).getResource("https://a.test/missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps an upstream 5xx to a 502 with the upstream status retained", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(client(fetchImpl).getResources({})).rejects.toMatchObject({
      status: 502,
      upstreamStatus: 503,
    });
  });

  it("maps a transport failure to 502 with upstreamStatus 0", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(client(fetchImpl).getResources({})).rejects.toMatchObject({
      status: 502,
      upstreamStatus: 0,
    });
  });

  it("rejects a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(client(fetchImpl).getResources({})).rejects.toBeInstanceOf(FacilitatorError);
  });

  it("POSTs JSON to verify and settle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { isValid: true }));
    await client(fetchImpl).verify({ a: 1 });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://facilitator.test/verify");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });
});
