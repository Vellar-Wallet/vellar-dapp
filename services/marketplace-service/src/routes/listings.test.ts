import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildServer } from "../server";
import {
  createMemoryListingRepository,
  createMemoryNonceRepository,
  type ListingRepository,
  type NonceRepository,
} from "../repository";
import { signedProofXdr, signedRegistrationXdr, stubFacilitator, TEST_PASSPHRASE } from "../test-support";

let app: FastifyInstance | undefined;

interface Harness {
  app: FastifyInstance;
  listings: ListingRepository;
  nonces: NonceRepository;
  now: () => Date;
  setNow: (d: Date) => void;
}

function build(overrides: { nonceTtlMs?: number } = {}): Harness {
  const listings = createMemoryListingRepository();
  const nonces = createMemoryNonceRepository();
  let current = new Date("2026-03-01T12:00:00.000Z");
  const now = () => current;
  let counter = 0;
  app = buildServer({
    facilitator: stubFacilitator(),
    listings,
    nonces,
    networkPassphrase: TEST_PASSPHRASE,
    nonceTtlMs: overrides.nonceTtlMs ?? 5 * 60_000,
    now,
    newId: () => `listing-${++counter}`,
  });
  return { app, listings, nonces, now, setNow: (d) => (current = d) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Issue a nonce and return it, as a client would. */
async function getNonce(h: Harness, address: string): Promise<string> {
  const res = await h.app.inject({
    method: "GET",
    url: `/marketplace/listings/nonce?address=${address}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().nonce;
}

function listingBody(seller: Keypair, signedXdr: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceUrl: "https://api.example.com/weather",
    title: "Weather API",
    description: "Forecast data",
    priceAtomic: "1000",
    asset: "USDC",
    scheme: "exact",
    signedXdr,
    walletAddress: seller.publicKey(),
    ...overrides,
  };
}

describe("GET /marketplace/listings/nonce", () => {
  it("returns a nonce with an expiry and stores it", async () => {
    const h = build();
    const address = Keypair.random().publicKey();
    const res = await h.app.inject({
      method: "GET",
      url: `/marketplace/listings/nonce?address=${address}`,
    });
    expect(res.statusCode).toBe(200);
    const { nonce, expiresAt } = res.json();
    // 32 bytes hex.
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe("2026-03-01T12:05:00.000Z");
    // Stored and consumable exactly once.
    expect(await h.nonces.consume(nonce, address, h.now())).toBe(true);
  });

  it("issues a distinct nonce per call", async () => {
    const h = build();
    const address = Keypair.random().publicKey();
    expect(await getNonce(h, address)).not.toBe(await getNonce(h, address));
  });

  it("rejects a non-Stellar address", async () => {
    const res = await build().app.inject({
      method: "GET",
      url: "/marketplace/listings/nonce?address=not-an-address",
    });
    expect(res.statusCode).toBe(400);
  });

  it("is not shadowed by the /:id route", async () => {
    const h = build();
    const res = await h.app.inject({
      method: "GET",
      url: `/marketplace/listings/nonce?address=${Keypair.random().publicKey()}`,
    });
    expect(res.json().nonce).toBeDefined();
  });
});

describe("POST /marketplace/listings", () => {
  it("creates a pending listing from a valid signed nonce", async () => {
    const h = build();
    const seller = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedRegistrationXdr(seller, nonce)),
    });
    expect(res.statusCode).toBe(201);
    const { listing } = res.json();
    expect(listing).toMatchObject({
      sellerAddress: seller.publicKey(),
      title: "Weather API",
      priceAtomic: "1000",
      // Activation is earned by a settlement, never granted at registration.
      status: "pending",
      totalSettlements: "0",
      firstSettledAt: null,
    });
  });

  it("rejects an expired nonce", async () => {
    const h = build();
    const seller = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    // Past the 5-minute TTL.
    h.setNow(new Date("2026-03-01T12:05:01.000Z"));
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedRegistrationXdr(seller, nonce)),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_nonce");
  });

  it("rejects a nonce that was already used", async () => {
    const h = build();
    const seller = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    const signedXdr = signedRegistrationXdr(seller, nonce);
    const first = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedXdr),
    });
    expect(first.statusCode).toBe(201);
    // Replaying the exact same envelope must fail.
    const replay = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedXdr, {
        resourceUrl: "https://api.example.com/other",
      }),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_nonce");
  });

  it("rejects a nonce issued to a different address", async () => {
    const h = build();
    const seller = Keypair.random();
    const attacker = Keypair.random();
    // Nonce belongs to the seller; the attacker signs it with their own key.
    const nonce = await getNonce(h, seller.publicKey());
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(attacker, signedRegistrationXdr(attacker, nonce)),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_nonce");
  });

  it("rejects an unknown nonce", async () => {
    const h = build();
    const seller = Keypair.random();
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedRegistrationXdr(seller, "f".repeat(64))),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a transaction signed by someone else", async () => {
    const h = build();
    const seller = Keypair.random();
    const impostor = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      // Impostor signs, but claims to be the seller.
      payload: listingBody(seller, signedRegistrationXdr(impostor, nonce)),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
  });

  it("rejects the wrong ManageData key", async () => {
    const h = build();
    const seller = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedRegistrationXdr(seller, nonce, { dataKey: "other-key" })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_registration_tx");
  });

  it("rejects a transaction carrying extra operations", async () => {
    const h = build();
    const seller = Keypair.random();
    const nonce = await getNonce(h, seller.publicKey());
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(seller, signedRegistrationXdr(seller, nonce, { extraOp: true })),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 when the resource URL is already listed (first registrant wins)", async () => {
    const h = build();
    const first = Keypair.random();
    const second = Keypair.random();
    await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(first, signedRegistrationXdr(first, await getNonce(h, first.publicKey()))),
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(
        second,
        signedRegistrationXdr(second, await getNonce(h, second.publicKey())),
      ),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("listing_exists");
  });
});

describe("GET /marketplace/listings/:id", () => {
  it("returns the listing", async () => {
    const h = build();
    const seller = Keypair.random();
    const created = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(
        seller,
        signedRegistrationXdr(seller, await getNonce(h, seller.publicKey())),
      ),
    });
    const id = created.json().listing.id;
    const res = await h.app.inject({ method: "GET", url: `/marketplace/listings/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().listing.id).toBe(id);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await build().app.inject({ method: "GET", url: "/marketplace/listings/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("listing_not_found");
  });
});

describe("PATCH /marketplace/listings/:id", () => {
  async function seed(h: Harness, seller: Keypair) {
    const created = await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(
        seller,
        signedRegistrationXdr(seller, await getNonce(h, seller.publicKey())),
      ),
    });
    return created.json().listing.id as string;
  }

  it("updates fields for the owning seller", async () => {
    const h = build();
    const seller = Keypair.random();
    const id = await seed(h, seller);
    h.setNow(new Date("2026-03-02T00:00:00.000Z"));
    const res = await h.app.inject({
      method: "PATCH",
      url: `/marketplace/listings/${id}`,
      payload: {
        title: "Better Weather API",
        priceAtomic: "2000",
        status: "paused",
        signedXdr: signedProofXdr(seller),
        walletAddress: seller.publicKey(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listing).toMatchObject({
      title: "Better Weather API",
      priceAtomic: "2000",
      status: "paused",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
  });

  it("returns 401 when a different address signs", async () => {
    const h = build();
    const seller = Keypair.random();
    const attacker = Keypair.random();
    const id = await seed(h, seller);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/marketplace/listings/${id}`,
      payload: {
        title: "Hijacked",
        signedXdr: signedProofXdr(attacker),
        walletAddress: attacker.publicKey(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("not_listing_owner");
    // And the listing is untouched.
    const after = await h.app.inject({ method: "GET", url: `/marketplace/listings/${id}` });
    expect(after.json().listing.title).toBe("Weather API");
  });

  it("returns 401 when the signature does not match the claimed address", async () => {
    const h = build();
    const seller = Keypair.random();
    const id = await seed(h, seller);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/marketplace/listings/${id}`,
      payload: {
        title: "Hijacked",
        // Claims to be the seller but signed by someone else.
        signedXdr: signedProofXdr(Keypair.random()),
        walletAddress: seller.publicKey(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
  });

  it("refuses to set status back to pending", async () => {
    const h = build();
    const seller = Keypair.random();
    const id = await seed(h, seller);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/marketplace/listings/${id}`,
      payload: {
        status: "pending",
        signedXdr: signedProofXdr(seller),
        walletAddress: seller.publicKey(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown listing", async () => {
    const h = build();
    const seller = Keypair.random();
    const res = await h.app.inject({
      method: "PATCH",
      url: "/marketplace/listings/nope",
      payload: {
        title: "x",
        signedXdr: signedProofXdr(seller),
        walletAddress: seller.publicKey(),
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /marketplace/listings", () => {
  it("returns every listing for a seller and excludes others", async () => {
    const h = build();
    const seller = Keypair.random();
    const other = Keypair.random();
    for (const url of ["https://a.example.com/x", "https://b.example.com/y"]) {
      await h.app.inject({
        method: "POST",
        url: "/marketplace/listings",
        payload: listingBody(
          seller,
          signedRegistrationXdr(seller, await getNonce(h, seller.publicKey())),
          { resourceUrl: url },
        ),
      });
    }
    await h.app.inject({
      method: "POST",
      url: "/marketplace/listings",
      payload: listingBody(other, signedRegistrationXdr(other, await getNonce(h, other.publicKey())), {
        resourceUrl: "https://c.example.com/z",
      }),
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/marketplace/listings?seller=${seller.publicKey()}`,
    });
    expect(res.statusCode).toBe(200);
    const { listings } = res.json();
    expect(listings).toHaveLength(2);
    expect(listings.every((l: { sellerAddress: string }) => l.sellerAddress === seller.publicKey())).toBe(true);
  });

  it("requires a valid seller address", async () => {
    const res = await build().app.inject({ method: "GET", url: "/marketplace/listings?seller=xyz" });
    expect(res.statusCode).toBe(400);
  });
});
