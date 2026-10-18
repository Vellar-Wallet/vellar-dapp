import type { FastifyInstance } from "fastify";
import proxy from "@fastify/http-proxy";
import {
  CircuitOpenError,
  createCircuitBreaker,
  domainMetrics,
  type CircuitBreaker,
  type CircuitState,
} from "@vellar/service-kit";
import { sendError } from "./error-envelope";

type ProxyPreHandler = NonNullable<Parameters<typeof proxy>[1]>["preHandler"];
type ProxyReplyOptions = NonNullable<Parameters<typeof proxy>[1]>["replyOptions"];

// Shared route registration helper (issue #355, extended for #546).
//
// Every downstream service is proxied with the same three-field config:
//   upstream  — the base URL of the backend service
//   prefix    — the path the gateway accepts (e.g. /wallet)
//   rewritePrefix — the path forwarded to the backend (usually the same)
//
// Without a helper each registration repeats those three lines identically.
// `registerProxyRoute` collapses them to a single call, keeps the prefix and
// rewritePrefix in sync by default (the common case), and centralises the
// place to extend shared proxy behaviour (per-upstream circuit breakers,
// observability, and versioned route registration).

export interface ProxyCircuitBreakerOptions {
  /** Logical upstream service identifier (e.g. "policy-service", "wallet-service"). */
  serviceName: string;
  /** Consecutive connection-level failures before the breaker trips open. Default: 5. */
  failureThreshold?: number;
  /** Cooldown in milliseconds before a half-open probe is permitted. Default: 30_000. */
  cooldownMs?: number;
  /** Custom machine-readable error code when open. Defaults to `<service_name>_unavailable`. */
  errorCode?: string;
  /** Optional clock override for deterministic tests. */
  now?: () => number;
  /** Optional pre-created CircuitBreaker instance (used internally to share state across /v1 and unversioned prefixes for the same upstream). */
  breaker?: CircuitBreaker;
  /** Optional state transition callback in addition to gateway logging/metrics. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface ProxyRouteOptions {
  /** Base URL of the upstream service, e.g. "http://localhost:4001". */
  upstream: string;
  /** Path prefix this gateway exposes, e.g. "/wallet". */
  prefix: string;
  /**
   * Path prefix forwarded to the upstream. Defaults to `prefix` — the almost-
   * universal case where the gateway prefix and the backend prefix are the same.
   */
  rewritePrefix?: string;
  /**
   * Optional per-upstream circuit breaker configuration (#546). Each upstream
   * gets its own isolated `CircuitBreaker` instance so a failing downstream
   * service (e.g. `policy-service`) fast-fails with 503 without degrading
   * healthy peers (`wallet-service`, `lifecycle-service`, `verification-service`).
   */
  circuitBreaker?: ProxyCircuitBreakerOptions;
  /**
   * Runs before the proxy forwards the request — the per-route extension
   * point this helper's own docstring anticipated ("circuit breakers, or
   * observability", #326). Return a reply to short-circuit (e.g. fast-fail
   * while a circuit breaker is open) without reaching the upstream at all.
   */
  preHandler?: ProxyPreHandler;
  /**
   * Passed straight through to `@fastify/http-proxy`'s `replyOptions` —
   * `onResponse`/`onError` hooks for observing the real outcome of each
   * proxied call (e.g. recording it against a circuit breaker, #326).
   */
  replyOptions?: ProxyReplyOptions;
}

export interface ProxyCircuitBreakerHooks {
  breaker: CircuitBreaker;
  preHandler: NonNullable<ProxyPreHandler>;
  replyOptions: NonNullable<ProxyReplyOptions>;
}

function defaultErrorCodeForService(serviceName: string): string {
  return `${serviceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}_unavailable`;
}

/**
 * Builds an isolated circuit breaker + Fastify proxy hooks (`preHandler` and
 * `replyOptions`) for a single upstream service (#546).
 *
 * Only connection-level proxy errors (`onError`: ECONNREFUSED, socket hang up,
 * upstream timeout) count as breaker failures. Any HTTP response received from
 * the upstream (`onResponse`, including 4xx/5xx domain responses) proves the
 * service is reachable and records a `"success"` outcome.
 */
export function createProxyCircuitBreakerHooks(
  app: Pick<FastifyInstance, "log">,
  options: ProxyCircuitBreakerOptions,
): ProxyCircuitBreakerHooks {
  const {
    serviceName,
    failureThreshold = 5,
    cooldownMs = 30_000,
    errorCode = defaultErrorCodeForService(serviceName),
    now,
    onStateChange,
  } = options;

  const breaker =
    options.breaker ??
    createCircuitBreaker({
      failureThreshold,
      cooldownMs,
      now,
      onStateChange: (from, to) => {
        app.log.warn({ breaker: serviceName, from, to }, "circuit breaker state change");
        domainMetrics.circuitBreakerStateChanges.inc({
          service: "api-gateway",
          breaker: serviceName,
          from,
          to,
        });
        onStateChange?.(from, to);
      },
    });

  const preHandler: NonNullable<ProxyPreHandler> = async (_request, reply) => {
    try {
      breaker.beforeCall();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return sendError(
          reply,
          503,
          errorCode,
          `Circuit breaker open: ${serviceName} is failing.`,
          { retryAfterMs: err.retryAfterMs },
        );
      }
      throw err;
    }
  };

  const replyOptions: NonNullable<ProxyReplyOptions> = {
    onResponse: (_request, reply, res) => {
      breaker.recordOutcome("success");
      reply.send(res.stream);
    },
    onError: (reply, error) => {
      breaker.recordOutcome("failure");
      reply.send(error.error);
    },
  };

  return { breaker, preHandler, replyOptions };
}

/**
 * Register a single proxy route on the Fastify app. Requests arriving at
 * `prefix/**` are forwarded to `upstream`, with the path rewritten to
 * `rewritePrefix/**` (defaults to `prefix`).
 *
 * @example
 * ```ts
 * registerProxyRoute(app, {
 *   upstream: walletServiceUrl,
 *   prefix: "/wallet",
 *   circuitBreaker: { serviceName: "wallet-service" },
 * });
 * ```
 */
export function registerProxyRoute(app: FastifyInstance, options: ProxyRouteOptions): void {
  const {
    upstream,
    prefix,
    rewritePrefix = prefix,
    circuitBreaker,
    preHandler: customPreHandler,
    replyOptions: customReplyOptions,
  } = options;

  const cbHooks = circuitBreaker ? createProxyCircuitBreakerHooks(app, circuitBreaker) : undefined;
  const preHandler = customPreHandler ?? cbHooks?.preHandler;
  const replyOptions = customReplyOptions
    ? { ...cbHooks?.replyOptions, ...customReplyOptions }
    : cbHooks?.replyOptions;

  app.register(proxy, { upstream, prefix, rewritePrefix, preHandler, replyOptions });
}

/**
 * Registers a proxy route under BOTH a versioned `/v1` prefix and the
 * legacy unversioned prefix, both rewriting to the same backend path
 * (issue #258). The legacy path is a temporary migration-window alias, not
 * a second surface to maintain long-term — see docs/api-versioning.md for
 * the deprecation policy. Both variants share every other option
 * (preHandler, replyOptions, circuit breakers, etc.) so a caller does not
 * need to duplicate route-specific logic to get both.
 */
export function registerVersionedProxyRoute(
  app: FastifyInstance,
  options: ProxyRouteOptions,
): void {
  const { prefix, rewritePrefix = prefix, circuitBreaker, ...rest } = options;
  // Instantiate the upstream's circuit breaker once so `/v1/<prefix>` and
  // `/<prefix>` share a single breaker state for that upstream while staying
  // completely independent from every other upstream service (#546).
  const sharedCircuitBreaker = circuitBreaker
    ? {
        ...circuitBreaker,
        breaker: createProxyCircuitBreakerHooks(app, circuitBreaker).breaker,
      }
    : undefined;

  registerProxyRoute(app, {
    ...rest,
    circuitBreaker: sharedCircuitBreaker,
    prefix: `/v1${prefix}`,
    rewritePrefix,
  });
  registerProxyRoute(app, {
    ...rest,
    circuitBreaker: sharedCircuitBreaker,
    prefix,
    rewritePrefix,
  });
}
