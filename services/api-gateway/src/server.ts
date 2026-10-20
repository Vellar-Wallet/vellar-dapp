import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  circuitBreakerLimitsFromEnv,
  CircuitOpenError,
  createCircuitBreaker,
  domainMetrics,
  injectTraceContext,
  registerHealth,
  registerMetrics,
  registerTracing,
} from "@vellar/service-kit";
import { registerErrorEnvelope, sendError } from "./error-envelope";
import { registerVersionedProxyRoute } from "./register-proxy-route";
import { TokenBucketLimiter } from "./token-bucket";

// Gateway (technical-doc.md §6.3, §8; idea.md §12): the single public entry
// point, so the cross-cutting security controls live HERE (defense at the
// boundary, applied once for every downstream service — not repeated per
// service). Controls in this file:
//   - CORS: only the configured web-app origin(s) may call the API.
//   - Rate limiting: per-IP request cap to blunt flooding/abuse.
//   - Tenant rate limiting: token bucket per tenant/session ID (#259).
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
  /** Token bucket capacity per tenant. Default 60; env TENANT_BUCKET_CAPACITY. */
  tenantBucketCapacity?: number;
  /** Token bucket refill rate (tokens/sec) per tenant. Default 10; env TENANT_BUCKET_REFILL_RATE. */
  tenantBucketRefillRate?: number;
  /** Max request body size in bytes. Default 1 MiB; env MAX_BODY_BYTES. */
  maxBodyBytes?: number;

  /** Per-request timeout in ms (connection-level). Default 310_000 — must
   * stay >= the x402 payment gate's maxTimeoutSeconds (300s on
   * /lifecycle/execute and /verification/:contractId) or the gateway kills a
   * legitimate, still-settling paid request before the facilitator responds
   * (confirmed empirically: a slow-but-correct proxied response gets cut at
   * exactly this timeout, independent of anything downstream). Env
   * REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Consecutive connection-level failures to wallet-service before the breaker opens. Default 5; env WALLET_CB_FAILURE_THRESHOLD. */
  walletCircuitFailureThreshold?: number;
  /** Cooldown (ms) before a half-open trial is allowed for wallet-service. Default 30_000; env WALLET_CB_COOLDOWN_MS. */
  walletCircuitCooldownMs?: number;
  /** Consecutive connection-level failures to lifecycle-service before the breaker opens. Default 5; env LIFECYCLE_CB_FAILURE_THRESHOLD. */
  lifecycleCircuitFailureThreshold?: number;
  /** Cooldown (ms) before a half-open trial is allowed for lifecycle-service. Default 30_000; env LIFECYCLE_CB_COOLDOWN_MS. */
  lifecycleCircuitCooldownMs?: number;
  /** Consecutive connection-level failures to policy-service before the breaker opens. Default 5; env POLICY_CB_FAILURE_THRESHOLD. */
  policyCircuitFailureThreshold?: number;
  /** Cooldown (ms) before a half-open trial is allowed for policy-service. Default 30_000; env POLICY_CB_COOLDOWN_MS. */
  policyCircuitCooldownMs?: number;
  /** Consecutive connection-level failures to verification-service before
   * the breaker opens. Default 5; env VERIFICATION_CB_FAILURE_THRESHOLD. */
  verificationCircuitFailureThreshold?: number;
  /** Cooldown (ms) before a half-open trial is allowed once open. Default
   * 30_000; env VERIFICATION_CB_COOLDOWN_MS. */
  verificationCircuitCooldownMs?: number;
  /** Custom logger instance or options (e.g. stream for capturing logs in tests). */
  logger?: unknown;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function buildServer(options: GatewayOptions = {}): FastifyInstance {
  const walletServiceUrl =
    options.walletServiceUrl ?? process.env.WALLET_SERVICE_URL ?? "http://localhost:4001";
  const DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://app.vellar.wallet",
    "https://vellar.wallet",
    "chrome-extension://vellar-wallet-extension",
  ];
  const corsOriginRaw = options.corsOrigin ?? process.env.CORS_ORIGIN;
  const corsOrigins = corsOriginRaw
    ? corsOriginRaw
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

  const maxBodyBytes = options.maxBodyBytes ?? numEnv("MAX_BODY_BYTES", 1024 * 1024);
  const requestTimeoutMs = options.requestTimeoutMs ?? numEnv("REQUEST_TIMEOUT_MS", 310_000);
  const rateLimitMax = options.rateLimitMax ?? numEnv("RATE_LIMIT_MAX", 120);
  const rateLimitWindowMs = options.rateLimitWindowMs ?? numEnv("RATE_LIMIT_WINDOW_MS", 60_000);
  const tenantBucketCapacity = options.tenantBucketCapacity ?? numEnv("TENANT_BUCKET_CAPACITY", 60);
  const tenantBucketRefillRate =
    options.tenantBucketRefillRate ?? numEnv("TENANT_BUCKET_REFILL_RATE", 10);

  const tenantLimiter = new TokenBucketLimiter({
    capacity: tenantBucketCapacity,
    refillRatePerSecond: tenantBucketRefillRate,
  });

  const app = Fastify({
    logger: options.logger !== undefined ? (options.logger as never) : true,
    disableRequestLogging: true,
    // Cap the request body so a giant payload can't tie up a downstream service.
    bodyLimit: maxBodyBytes,
    // Drop slow/stalled connections rather than letting them hold resources.
    connectionTimeout: requestTimeoutMs,
  });

  // Standardized error envelope (issue #262) for every response this
  // gateway sends directly (a proxied upstream error is forwarded
  // unchanged, not touched by this).
  registerErrorEnvelope(app);

  // Distributed tracing (#301): the gateway's server span is the root every
  // downstream hop parents onto. Registered before the boundary hook below,
  // which reads request.traceContext to rewrite the proxied headers.
  registerTracing(app, "api-gateway");

  // Structured request logging middleware (idea.md §13, docs/observability.md):
  // Emits structured JSON containing method, path, status, and duration for every request.
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        duration: reply.elapsedTime,
      },
      "request completed",
    );
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
  // only explicitly configured web and extension origins are allowed.
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const isAllowed = corsOrigins.some((allowed) => {
        if (allowed === origin) return true;
        if (allowed.includes("*")) {
          const regex = new RegExp("^" + allowed.replace(/\*/g, ".*") + "$");
          return regex.test(origin);
        }
        return false;
      });
      if (isAllowed) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    // Let the web app read which trace served a request (#301).
    exposedHeaders: ["traceparent", "x-trace-id"],
  });

  // Boundary checks that must run BEFORE proxying. @fastify/http-proxy streams
  // the body straight through, so Fastify's own `bodyLimit` (which only applies
  // to routes that PARSE the body) does not protect proxied routes — we enforce
  // the size cap here on Content-Length, and the content-type/CSRF check too.
  app.addHook("onRequest", async (request, reply) => {
    const method = request.method.toUpperCase();
    const isMutation = method === "POST" || method === "PUT" || method === "PATCH";

    // Distributed tracing context propagation (#301): overwrite whatever the
    // client sent with the gateway span's context, so the upstream service's
    // server span is a child of the gateway span (same traceId, parent = us).
    if (request.traceContext) {
      for (const [key, value] of Object.entries(injectTraceContext(request.traceContext))) {
        request.headers[key] = value;
      }
    }

    // Per-tenant token bucket rate limit (#259)
    const tenantId = (request.headers["x-tenant-id"] || request.headers["x-session-id"]) as
      string | undefined;
    if (tenantId && request.url !== "/health") {
      const result = tenantLimiter.tryConsume(tenantId);
      if (!result.allowed) {
        reply.header("Retry-After", String(result.retryAfterSeconds ?? 1));
        return sendError(
          reply,
          429,
          "too_many_requests",
          "Tenant rate limit exceeded. Please retry later.",
          {
            retryAfter: result.retryAfterSeconds,
          },
        );
      }
    }

    // Body-size cap (413) — reject before the body is streamed upstream.
    const declaredLen = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
      return sendError(reply, 413, "payload_too_large", `Body exceeds ${maxBodyBytes} bytes.`);
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
        return sendError(
          reply,
          415,
          "unsupported_media_type",
          "Content-Type must be application/json.",
        );
      }
    }
  });

  registerHealth(app, "api-gateway");
  registerMetrics(app, "api-gateway");

  const walletBreakerLimits = circuitBreakerLimitsFromEnv(
    {
      failureThresholdVar: "WALLET_CB_FAILURE_THRESHOLD",
      cooldownMsVar: "WALLET_CB_COOLDOWN_MS",
    },
    { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
  );
  registerVersionedProxyRoute(app, {
    upstream: walletServiceUrl,
    prefix: "/wallet",
    circuitBreaker: {
      serviceName: "wallet-service",
      failureThreshold:
        options.walletCircuitFailureThreshold ?? walletBreakerLimits.failureThreshold,
      cooldownMs: options.walletCircuitCooldownMs ?? walletBreakerLimits.cooldownMs,
    },
  });

  const lifecycleServiceUrl =
    options.lifecycleServiceUrl ?? process.env.LIFECYCLE_SERVICE_URL ?? "http://localhost:4002";
  const lifecycleBreakerLimits = circuitBreakerLimitsFromEnv(
    {
      failureThresholdVar: "LIFECYCLE_CB_FAILURE_THRESHOLD",
      cooldownMsVar: "LIFECYCLE_CB_COOLDOWN_MS",
    },
    { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
  );
  registerVersionedProxyRoute(app, {
    upstream: lifecycleServiceUrl,
    prefix: "/lifecycle",
    circuitBreaker: {
      serviceName: "lifecycle-service",
      failureThreshold:
        options.lifecycleCircuitFailureThreshold ?? lifecycleBreakerLimits.failureThreshold,
      cooldownMs: options.lifecycleCircuitCooldownMs ?? lifecycleBreakerLimits.cooldownMs,
    },
  });

  const policyServiceUrl =
    options.policyServiceUrl ?? process.env.POLICY_SERVICE_URL ?? "http://localhost:4003";
  const policyBreakerLimits = circuitBreakerLimitsFromEnv(
    {
      failureThresholdVar: "POLICY_CB_FAILURE_THRESHOLD",
      cooldownMsVar: "POLICY_CB_COOLDOWN_MS",
    },
    { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
  );
  registerVersionedProxyRoute(app, {
    upstream: policyServiceUrl,
    prefix: "/policies",
    circuitBreaker: {
      serviceName: "policy-service",
      failureThreshold:
        options.policyCircuitFailureThreshold ?? policyBreakerLimits.failureThreshold,
      cooldownMs: options.policyCircuitCooldownMs ?? policyBreakerLimits.cooldownMs,
    },
  });

  const verificationServiceUrl =
    options.verificationServiceUrl ??
    process.env.VERIFICATION_SERVICE_URL ??
    "http://localhost:4004";

  // Circuit breaker (#326, generalized per-upstream in #546): each upstream
  // service gets its own isolated CircuitBreaker instance so an outage in one
  // downstream never trips or degrades the other three.
  const verificationBreakerLimits = circuitBreakerLimitsFromEnv(
    {
      failureThresholdVar: "VERIFICATION_CB_FAILURE_THRESHOLD",
      cooldownMsVar: "VERIFICATION_CB_COOLDOWN_MS",
    },
    { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
  );
  registerVersionedProxyRoute(app, {
    upstream: verificationServiceUrl,
    prefix: "/verification",
    circuitBreaker: {
      serviceName: "verification-service",
      failureThreshold:
        options.verificationCircuitFailureThreshold ?? verificationBreakerLimits.failureThreshold,
      cooldownMs: options.verificationCircuitCooldownMs ?? verificationBreakerLimits.cooldownMs,
    },
  });

  return app;
}
