import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NonceError, NotFoundError, SignatureError } from "../lib/errors";
import { isValidStellarAddress, verifyRegistrationSignature, verifySignedBy } from "../lib/signature";
import {
  DuplicateListingError,
  type ListingRecord,
  type ListingRepository,
  type NonceRepository,
} from "../repository";

// Seller listing routes (new-build-technical-doc.md §5.2).

const addressSchema = z
  .string()
  .refine(isValidStellarAddress, "must be a valid Stellar G-address");

const nonceQuerySchema = z.object({ address: addressSchema });

const createListingSchema = z.object({
  resourceUrl: z.url(),
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  priceAtomic: z.string().regex(/^\d+$/, "priceAtomic must be base units as a decimal string"),
  asset: z.string().min(1),
  scheme: z.enum(["exact", "upto"]).default("exact"),
  signedXdr: z.string().min(1),
  walletAddress: addressSchema,
});

const patchListingSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional(),
  priceAtomic: z.string().regex(/^\d+$/).optional(),
  scheme: z.enum(["exact", "upto"]).optional(),
  // "pending" is omitted deliberately: pending→active is earned by a real
  // settlement (§5.2), never self-declared by the seller.
  status: z.enum(["active", "paused", "removed"]).optional(),
  signedXdr: z.string().min(1),
  walletAddress: addressSchema,
});

const listQuerySchema = z.object({ seller: addressSchema });

export interface ListingRouteDeps {
  listings: ListingRepository;
  nonces: NonceRepository;
  networkPassphrase: string;
  nonceTtlMs: number;
  now?: () => Date;
  newId?: () => string;
  newNonce?: () => string;
}

/** The public listing shape. Identical to the stored record today, but kept as
 * an explicit projection so an added internal column is never leaked by
 * accident. */
function toPublicListing(listing: ListingRecord) {
  return {
    id: listing.id,
    sellerAddress: listing.sellerAddress,
    resourceUrl: listing.resourceUrl,
    title: listing.title,
    description: listing.description,
    priceAtomic: listing.priceAtomic,
    asset: listing.asset,
    scheme: listing.scheme,
    status: listing.status,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    firstSettledAt: listing.firstSettledAt,
    totalSettlements: listing.totalSettlements,
    totalRevenue: listing.totalRevenue,
  };
}

export function registerListingRoutes(app: FastifyInstance, deps: ListingRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  // 32 bytes of CSPRNG, hex-encoded — the nonce is an unguessable challenge,
  // so it must not come from Math.random or a timestamp.
  const newNonce = deps.newNonce ?? (() => randomBytes(32).toString("hex"));

  app.get("/marketplace/listings/nonce", async (request, reply) => {
    const parsed = nonceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + deps.nonceTtlMs);
    const nonce = newNonce();
    await deps.nonces.insert({
      nonce,
      address: parsed.data.address,
      createdAt: issuedAt.toISOString(),
      usedAt: null,
      expiresAt: expiresAt.toISOString(),
    });
    return reply.send({ nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post("/marketplace/listings", async (request, reply) => {
    const parsed = createListingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const body = parsed.data;

    // Full proof: structure + signature (throws 400/401), then single-use
    // consumption of the nonce, which is what makes registration unreplayable.
    const { nonce } = verifyRegistrationSignature(
      body.signedXdr,
      body.walletAddress,
      deps.networkPassphrase,
    );
    const consumed = await deps.nonces.consume(nonce, body.walletAddress, now());
    if (!consumed) {
      // One message for unknown / expired / already-used / wrong-address, so
      // the response cannot be used to probe which nonces exist.
      throw new NonceError();
    }

    const at = now().toISOString();
    const record: ListingRecord = {
      id: newId(),
      sellerAddress: body.walletAddress,
      resourceUrl: body.resourceUrl,
      title: body.title,
      description: body.description ?? null,
      priceAtomic: body.priceAtomic,
      asset: body.asset,
      scheme: body.scheme,
      // §5.2: a listing is born pending and is promoted by its first settlement.
      status: "pending",
      createdAt: at,
      updatedAt: at,
      firstSettledAt: null,
      totalSettlements: "0",
      totalRevenue: "0",
    };

    try {
      await deps.listings.insert(record);
    } catch (err) {
      if (err instanceof DuplicateListingError) {
        // §14 Q4: first valid registrant owns the URL.
        return reply.code(409).send({ error: "listing_exists", message: err.message });
      }
      throw err;
    }

    return reply.code(201).send({ listing: toPublicListing(record) });
  });

  app.get<{ Params: { id: string } }>("/marketplace/listings/:id", async (request, reply) => {
    const listing = await deps.listings.findById(request.params.id);
    if (!listing) throw new NotFoundError("Listing not found", "listing_not_found");
    return reply.send({ listing: toPublicListing(listing) });
  });

  app.patch<{ Params: { id: string } }>("/marketplace/listings/:id", async (request, reply) => {
    const parsed = patchListingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { signedXdr, walletAddress, ...patch } = parsed.data;

    const listing = await deps.listings.findById(request.params.id);
    if (!listing) throw new NotFoundError("Listing not found", "listing_not_found");

    // Prove key control (throws 400/401)…
    verifySignedBy(signedXdr, walletAddress, deps.networkPassphrase);
    // …then prove it is THIS listing's seller. Both are required: a valid
    // signature from some other address must not edit this row.
    if (listing.sellerAddress !== walletAddress) {
      throw new SignatureError("Signer is not the seller of this listing", "not_listing_owner");
    }

    const updated = await deps.listings.update(request.params.id, patch, now());
    if (!updated) throw new NotFoundError("Listing not found", "listing_not_found");
    return reply.send({ listing: toPublicListing(updated) });
  });

  app.get("/marketplace/listings", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const listings = await deps.listings.listBySeller(parsed.data.seller);
    return reply.send({ listings: listings.map(toPublicListing) });
  });
}
