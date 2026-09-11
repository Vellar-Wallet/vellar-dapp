import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FacilitatorApi, FacilitatorResource } from "../lib/facilitator";
import { ValidationError } from "../lib/errors";
import type { ListingRepository } from "../repository";

// Catalog routes (new-build-technical-doc.md §4.4). These proxy the
// facilitator's discovery endpoints and enrich each entry with the marketplace
// listing metadata we hold locally.

const listQuerySchema = z.object({
  scheme: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  // Capped at 100 per §4.4 so one request can't ask the facilitator for the
  // entire catalog.
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1, "q is required"),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export interface MarketplaceResource {
  id: string;
  resourceUrl: string;
  title?: string;
  description?: string;
  priceAtomic?: string;
  asset?: string;
  scheme?: string;
  network?: string;
  payTo?: string;
  areFeesSponsored?: boolean;
  listing?: {
    id: string;
    sellerAddress: string;
    status: string;
    totalSettlements: string;
    totalRevenue: string;
    firstSettledAt: string | null;
  };
  trust?: {
    settlementCount: string;
    firstSeen: string | null;
    isRegistered: boolean;
  };
}

/** base64url of the resource URL — the `:id` in §4.4's detail route. */
export function encodeResourceId(resourceUrl: string): string {
  return Buffer.from(resourceUrl, "utf8").toString("base64url");
}

export function decodeResourceId(id: string): string {
  // base64url uses [A-Za-z0-9_-]; anything else is malformed, and Buffer would
  // silently ignore it rather than fail, so reject explicitly (§4.4 → 400).
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ValidationError("id must be base64url of the resource URL", "invalid_resource_id");
  }
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  if (!decoded) {
    throw new ValidationError("id must be base64url of the resource URL", "invalid_resource_id");
  }
  // Round-trip check: base64url is not injective over arbitrary input (padding
  // and stray characters both decode), so confirm the id is the canonical
  // encoding of what it decoded to.
  if (encodeResourceId(decoded) !== id) {
    throw new ValidationError("id must be base64url of the resource URL", "invalid_resource_id");
  }
  return decoded;
}

/** Merge a facilitator catalog entry with our listing row, when we have one. */
export function toMarketplaceResource(
  resource: FacilitatorResource,
  listing?: Awaited<ReturnType<ListingRepository["findByResourceUrl"]>>,
): MarketplaceResource {
  return {
    id: encodeResourceId(resource.resourceUrl),
    resourceUrl: resource.resourceUrl,
    // A seller-registered title/description outranks the facilitator's, which
    // is derived from whatever the resource advertised at settlement time.
    title: listing?.title ?? resource.title,
    description: listing?.description ?? resource.description,
    priceAtomic: listing?.priceAtomic ?? resource.priceAtomic,
    asset: listing?.asset ?? resource.asset,
    scheme: listing?.scheme ?? resource.scheme,
    network: resource.network,
    payTo: resource.payTo,
    areFeesSponsored: resource.areFeesSponsored,
    listing: listing
      ? {
          id: listing.id,
          sellerAddress: listing.sellerAddress,
          status: listing.status,
          totalSettlements: listing.totalSettlements,
          totalRevenue: listing.totalRevenue,
          firstSettledAt: listing.firstSettledAt,
        }
      : undefined,
    trust: {
      settlementCount: listing?.totalSettlements ?? "0",
      firstSeen: listing?.firstSettledAt ?? null,
      // §14 Q2: trust is settlement history + registration, not identity.
      isRegistered: Boolean(listing),
    },
  };
}

export interface CatalogRouteDeps {
  facilitator: FacilitatorApi;
  listings: ListingRepository;
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  /** Look up local listings for a page of catalog entries. */
  const enrich = async (resources: FacilitatorResource[]): Promise<MarketplaceResource[]> =>
    Promise.all(
      resources.map(async (resource) =>
        toMarketplaceResource(
          resource,
          resource.resourceUrl
            ? await deps.listings.findByResourceUrl(resource.resourceUrl)
            : undefined,
        ),
      ),
    );

  app.get("/marketplace/catalog", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { scheme, asset, limit, cursor } = parsed.data;
    const result = await deps.facilitator.getResources({ scheme, asset, limit, cursor });
    return reply.send({
      resources: await enrich(result.resources),
      pagination: { limit, cursor: cursor ?? null, nextCursor: result.nextCursor ?? null },
    });
  });

  app.get("/marketplace/catalog/search", async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { q, limit } = parsed.data;
    const result = await deps.facilitator.searchResources(q, limit);
    return reply.send({
      resources: await enrich(result.resources),
      query: q,
      partialResults: result.partialResults,
    });
  });

  app.get<{ Params: { id: string } }>("/marketplace/catalog/:id", async (request, reply) => {
    const resourceUrl = decodeResourceId(request.params.id);
    const resource = await deps.facilitator.getResource(resourceUrl);
    const listing = await deps.listings.findByResourceUrl(resourceUrl);
    return reply.send({ resource: toMarketplaceResource(resource, listing) });
  });
}
