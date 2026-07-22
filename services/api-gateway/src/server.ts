import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import proxy from "@fastify/http-proxy";
import rateLimit from "@fastify/rate-limit";
import { registerHealth, registerMetrics } from "@vela/service-kit";

// Gateway (technical-doc.md §6.3, §8; idea.md §12): the single public entry
// point, so the cross-cutting security controls live HERE (defense at the
// boundary, applied once for every downstream service — not repeated per
// service). Controls in this file:
//   - CORS: only the configured web-app origin(s) may call the API.
//   - Rate limiting: per-IP request cap to blunt flooding/abuse.
//   - Security headers (helmet): HSTS, nosniff, frame-deny, referrer policy.
//   - Body-size + request timeout caps: cheap abuse protection.
//   - Content-type enforcement on mutations: the CSRF mitigation appropriate to
//     this API's model (see the note on the hook below).

export interface GatewayOptions {
  walletServiceUrl?: string;
  lifecycleServiceUrl?: string;
  policyServiceUrl?: string;
  verificationServiceUrl?: string;
  corsOrigin?: string;
  /** Max requests per IP per window. Default 120/min; env RATE_LIMIT_MAX. */
  rateLimitMax?: number;
  /** Rate-limit window in ms. Default 60_000; env RATE_LIMIT_WINDOW_MS. */
  rateLimitWindowMs?: number;
  /** Max request body size in bytes. Default 1 MiB; env MAX_BODY_BYTES. */
  maxBodyBytes?: number;
  /** Per-request timeout in ms (connection-level). Default 30_000. */
  requestTimeoutMs?: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

  const maxBodyBytes = options.maxBodyBytes ?? numEnv("MAX_BODY_BYTES", 1024 * 1024);
  const requestTimeoutMs = options.requestTimeoutMs ?? numEnv("REQUEST_TIMEOUT_MS", 30_000);
  const rateLimitMax = options.rateLimitMax ?? numEnv("RATE_LIMIT_MAX", 120);
  const rateLimitWindowMs = options.rateLimitWindowMs ?? numEnv("RATE_LIMIT_WINDOW_MS", 60_000);

  const app = Fastify({
    logger: true,
    // Cap the request body so a giant payload can't tie up a downstream service.
    bodyLimit: maxBodyBytes,
    // Drop slow/stalled connections rather than letting them hold resources.
    connectionTimeout: requestTimeoutMs,
  });

  // Security headers. CSP is disabled: this is a JSON API, not an HTML origin,
  // so a page-oriented CSP adds no value and risks surprising downstream
  // responses. The rest (HSTS, X-Content-Type-Options, frameguard, referrer
  // policy) are pure hardening with no behavioral cost.
  app.register(helmet, { contentSecurityPolicy: false });

  // Per-IP rate limit across the whole gateway. /health is exempt (below) so
  // liveness probes aren't throttled. Returns 429 with Retry-After when tripped.
  app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    allowList: (req) => req.url === "/health",
  });

  // Browser clients (web app on its own origin) call this gateway directly;
  // only the configured origin(s) are allowed (technical-doc.md §8.3). DELETE
  // must be listed explicitly — the plugin's default (GET,HEAD,POST) fails
  // session revocation at preflight.
  app.register(cors, { origin: corsOrigin, methods: ["GET", "POST", "DELETE"] });

  // Boundary checks that must run BEFORE proxying. @fastify/http-proxy streams
  // the body straight through, so Fastify's own `bodyLimit` (which only applies
  // to routes that PARSE the body) does not protect proxied routes — we enforce
  // the size cap here on Content-Length, and the content-type/CSRF check too.
  app.addHook("onRequest", async (request, reply) => {
    const method = request.method.toUpperCase();
    const isMutation = method === "POST" || method === "PUT" || method === "PATCH";

    // Body-size cap (413) — reject before the body is streamed upstream.
    const declaredLen = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
      return reply
        .code(413)
        .send({ error: "payload_too_large", reason: `body exceeds ${maxBodyBytes} bytes` });
    }

    // CSRF mitigation for a cookieless API (idea.md §12): this gateway uses no
    // ambient cookie/session auth, so classic token-CSRF doesn't apply — a
    // cross-site attacker can't ride a session that doesn't exist. The residual
    // CSRF vector is a form-driven "simple request"; block it by requiring a
    // JSON content-type on every state-changing method. Combined with the strict
    // CORS allowlist, this closes the cross-site write path. (docs/decisions.md.)
    if (isMutation) {
      const ct = request.headers["content-type"] ?? "";
      if (!ct.toLowerCase().includes("application/json")) {
        return reply.code(415).send({
          error: "unsupported_media_type",
          reason: "Content-Type must be application/json",
        });
      }
    }
  });

  registerHealth(app, "api-gateway");
  registerMetrics(app, "api-gateway");

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

  const verificationServiceUrl =
    options.verificationServiceUrl ??
    process.env.VERIFICATION_SERVICE_URL ??
    "http://localhost:4004";
  app.register(proxy, {
    upstream: verificationServiceUrl,
    prefix: "/verification",
    rewritePrefix: "/verification",
  });

  return app;
}
