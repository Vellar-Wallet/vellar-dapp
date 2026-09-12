import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server";
import { FacilitatorError } from "../lib/errors";
import { decodeResourceId, encodeResourceId } from "./catalog";
import { resource, stubFacilitator, TEST_PASSPHRASE } from "../test-support";
import { createMemoryListingRepository } from "../repository";

let app: FastifyInstance | undefined;

function build(facilitator = stubFacilitator(), listings = createMemoryListingRepository()) {
  app = buildServer({ facilitator, listings, networkPassphrase: TEST_PASSPHRASE });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("resource id encoding", () => {
  it("round-trips a URL through base64url", () => {
    const url = "https://api.example.com/a?b=c&d=e";
    expect(decodeResourceId(encodeResourceId(url))).toBe(url);
  });

  it.each([
    ["non-base64url characters", "not a valid id!"],
    ["padding", "aGVsbG8="],
    ["empty", ""],
  ])("rejects %s", (_label, id) => {
    expect(() => decodeResourceId(id)).toThrow();
  });
});

describe("GET /marketplace/catalog", () => {
  it("returns resources from the facilitator", async () => {
    const res = await build().inject({ method: "GET", url: "/marketplace/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0].resourceUrl).toBe("https://api.example.com/weather");
    expect(body.resources[0].id).toBe(encodeResourceId("https://api.example.com/weather"));
  });

  it("passes filters and the limit through to the facilitator", async () => {
    const getResources = vi.fn().mockResolvedValue({ resources: [], nextCursor: "c2" });
    const res = await build(stubFacilitator({ getResources })).inject({
      method: "GET",
      url: "/marketplace/catalog?scheme=upto&asset=USDC&limit=5&cursor=c1",
    });
    expect(res.statusCode).toBe(200);
    expect(getResources).toHaveBeenCalledWith({
      scheme: "upto",
      asset: "USDC",
      limit: 5,
      cursor: "c1",
    });
    expect(res.json().pagination).toEqual({ limit: 5, cursor: "c1", nextCursor: "c2" });
  });

  it("defaults the limit to 20 and rejects one above the 100 cap", async () => {
    const getResources = vi.fn().mockResolvedValue({ resources: [] });
    const built = build(stubFacilitator({ getResources }));
    await built.inject({ method: "GET", url: "/marketplace/catalog" });
    expect(getResources.mock.calls[0]?.[0]).toMatchObject({ limit: 20 });

    const over = await built.inject({ method: "GET", url: "/marketplace/catalog?limit=101" });
    expect(over.statusCode).toBe(400);
  });

  it("enriches an entry with the local listing when one is registered", async () => {
    const listings = createMemoryListingRepository();
    await listings.insert({
      id: "listing-1",
      sellerAddress: "GSELLER",
      resourceUrl: "https://api.example.com/weather",
      title: "Seller title",
      description: "Seller description",
      priceAtomic: "2500",
      asset: "USDC",
      scheme: "exact",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      firstSettledAt: "2026-01-02T00:00:00.000Z",
      totalSettlements: "7",
      totalRevenue: "17500",
    });
    const res = await build(stubFacilitator(), listings).inject({
      method: "GET",
      url: "/marketplace/catalog",
    });
    const entry = res.json().resources[0];
    // The seller-registered metadata wins over the facilitator's.
    expect(entry.title).toBe("Seller title");
    expect(entry.priceAtomic).toBe("2500");
    expect(entry.listing.sellerAddress).toBe("GSELLER");
    expect(entry.trust).toEqual({
      settlementCount: "7",
      firstSeen: "2026-01-02T00:00:00.000Z",
      isRegistered: true,
    });
  });

  it("marks an unregistered entry as untrusted-by-registration", async () => {
    const res = await build().inject({ method: "GET", url: "/marketplace/catalog" });
    expect(res.json().resources[0].trust).toEqual({
      settlementCount: "0",
      firstSeen: null,
      isRegistered: false,
    });
  });

  it("surfaces a facilitator outage as 502", async () => {
    const getResources = vi.fn().mockRejectedValue(new FacilitatorError(0, "upstream down", 502));
    const res = await build(stubFacilitator({ getResources })).inject({
      method: "GET",
      url: "/marketplace/catalog",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("facilitator_error");
  });
});

describe("GET /marketplace/catalog/search", () => {
  it("returns search results for a query", async () => {
    const searchResources = vi
      .fn()
      .mockResolvedValue({ resources: [resource()], query: "weather", partialResults: true });
    const res = await build(stubFacilitator({ searchResources })).inject({
      method: "GET",
      url: "/marketplace/catalog/search?q=weather&limit=3",
    });
    expect(res.statusCode).toBe(200);
    expect(searchResources).toHaveBeenCalledWith("weather", 3);
    expect(res.json()).toMatchObject({ query: "weather", partialResults: true });
    expect(res.json().resources).toHaveLength(1);
  });

  it("requires q", async () => {
    const res = await build().inject({ method: "GET", url: "/marketplace/catalog/search" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_query");
  });
});

describe("GET /marketplace/catalog/:id", () => {
  it("decodes the base64url id and returns the detail", async () => {
    const url = "https://api.example.com/weather";
    const getResource = vi.fn().mockResolvedValue(resource());
    const res = await build(stubFacilitator({ getResource })).inject({
      method: "GET",
      url: `/marketplace/catalog/${encodeResourceId(url)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(getResource).toHaveBeenCalledWith(url);
    expect(res.json().resource.resourceUrl).toBe(url);
  });

  it("returns 400 for an id that is not base64url", async () => {
    const res = await build().inject({ method: "GET", url: "/marketplace/catalog/!!!not-valid!!!" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_resource_id");
  });

  it("returns 404 when the facilitator has no such resource", async () => {
    const getResource = vi
      .fn()
      .mockRejectedValue(new FacilitatorError(404, "No catalog entry", 404, "not_found"));
    const res = await build(stubFacilitator({ getResource })).inject({
      method: "GET",
      url: `/marketplace/catalog/${encodeResourceId("https://api.example.com/missing")}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
