import Fastify, { type FastifyInstance } from "fastify";
import { registerHealth, registerMetrics } from "@vellar/service-kit";
import { MarketplaceError } from "./lib/errors";
import type { FacilitatorApi } from "./lib/facilitator";
import {
  createMemoryListingRepository,
  createMemoryNonceRepository,
  type ListingRepository,
  type NonceRepository,
} from "./repository";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerPaymentRoutes } from "./routes/payments";
import { registerListingRoutes } from "./routes/listings";
import { DEFAULTS } from "./config";

// Marketplace API (new-build-technical-doc.md §4–§5). This service is the ONLY
// component that talks to vellar-facilitator (§4.1) — the web app never does.

export interface MarketplaceServiceDeps {
  /** The facilitator client. Required: every catalog and payment route needs it. */
  facilitator: FacilitatorApi;
  listings?: ListingRepository;
  nonces?: NonceRepository;
  /** Passphrase used to parse signed XDR. From SERVER config, never a request
   * body (security-audit V5). */
  networkPassphrase: string;
  nonceTtlMs?: number;
  /** Readiness probe for DB-aware /health (FIX 7). */
  isReady?: () => boolean | Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
  newNonce?: () => string;
  /** Test seam for the direct resource fetch in /payments/quote. */
  fetchImpl?: typeof fetch;
}

export function buildServer(deps: MarketplaceServiceDeps): FastifyInstance {
  const listings = deps.listings ?? createMemoryListingRepository();
  const nonces = deps.nonces ?? createMemoryNonceRepository();

  const app = Fastify({ logger: true });
  registerHealth(app, "marketplace-service", { isReady: deps.isReady });
  registerMetrics(app, "marketplace-service");

  // One error mapper for every route: handlers throw typed MarketplaceErrors
  // and the HTTP shape is decided here, so no route invents its own body.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MarketplaceError) {
      // 5xx is our fault and worth a stack; 4xx is the caller's and is noise.
      if (error.status >= 500) request.log.error(error, "marketplace request failed");
      else request.log.warn({ code: error.code }, error.message);
      return reply.code(error.status).send(error.toBody());
    }
    // Fastify's own errors (bad JSON, unsupported media type) carry a status.
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const status = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;
    if (status >= 500) {
      request.log.error(error, "unhandled marketplace error");
      // Never leak an internal message to the client.
      return reply.code(500).send({ error: "internal_error", message: "Unexpected server error" });
    }
    return reply.code(status).send({
      error: fastifyError.code ?? "bad_request",
      message: fastifyError.message ?? "Bad request",
    });
  });

  registerCatalogRoutes(app, { facilitator: deps.facilitator, listings });
  registerPaymentRoutes(app, {
    facilitator: deps.facilitator,
    networkPassphrase: deps.networkPassphrase,
    fetchImpl: deps.fetchImpl,
  });
  // Registered after catalog so the literal /listings/nonce route is declared
  // before /listings/:id could ever shadow it.
  registerListingRoutes(app, {
    listings,
    nonces,
    networkPassphrase: deps.networkPassphrase,
    nonceTtlMs: deps.nonceTtlMs ?? DEFAULTS.nonceTtlMs,
    now: deps.now,
    newId: deps.newId,
    newNonce: deps.newNonce,
  });

  return app;
}
