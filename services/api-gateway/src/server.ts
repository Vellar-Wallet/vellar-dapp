import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import { registerHealth } from "@vela/service-kit";

// Gateway (technical-doc.md §6.3): unified API entrypoint. Auth/session
// middleware and rate limiting attach here as cross-cutting concerns; routes
// proxy to the owning service.

export interface GatewayOptions {
  walletServiceUrl?: string;
  lifecycleServiceUrl?: string;
  policyServiceUrl?: string;
  corsOrigin?: string;
}

export function buildServer(options: GatewayOptions = {}): FastifyInstance {
  const walletServiceUrl =
    options.walletServiceUrl ?? process.env.WALLET_SERVICE_URL ?? "http://localhost:4001";
  const corsOriginRaw = options.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:3000";
  // CORS_ORIGIN may list several allowed origins, comma-separated (e.g. the
  // apex and www variants of a domain). A single value stays a string.
  const corsOrigins = corsOriginRaw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const corsOrigin = corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins;

  const app = Fastify({ logger: true });

  // Browser clients (web app on its own origin) call this gateway directly;
  // only the configured origin(s) are allowed (technical-doc.md §8.3). DELETE
  // must be listed explicitly — the plugin's default (GET,HEAD,POST) fails
  // session revocation at preflight.
  app.register(cors, { origin: corsOrigin, methods: ["GET", "POST", "DELETE"] });

  registerHealth(app, "api-gateway");

  app.register(proxy, {
    upstream: walletServiceUrl,
    prefix: "/wallet",
    rewritePrefix: "/wallet",
  });

  const lifecycleServiceUrl =
    options.lifecycleServiceUrl ?? process.env.LIFECYCLE_SERVICE_URL ?? "http://localhost:4002";
  app.register(proxy, {
    upstream: lifecycleServiceUrl,
    prefix: "/lifecycle",
    rewritePrefix: "/lifecycle",
  });

  const policyServiceUrl =
    options.policyServiceUrl ?? process.env.POLICY_SERVICE_URL ?? "http://localhost:4003";
  app.register(proxy, {
    upstream: policyServiceUrl,
    prefix: "/policies",
    rewritePrefix: "/policies",
  });

  return app;
}
