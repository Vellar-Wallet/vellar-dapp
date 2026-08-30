import type { FastifyInstance } from "fastify";
import proxy from "@fastify/http-proxy";

type ProxyPreHandler = NonNullable<Parameters<typeof proxy>[1]>["preHandler"];
type ProxyReplyOptions = NonNullable<Parameters<typeof proxy>[1]>["replyOptions"];

// Shared route registration helper (issue #355).
//
// Every downstream service is proxied with the same three-field config:
//   upstream  — the base URL of the backend service
//   prefix    — the path the gateway accepts (e.g. /wallet)
//   rewritePrefix — the path forwarded to the backend (usually the same)
//
// Without a helper each registration repeats those three lines identically.
// `registerProxyRoute` collapses them to a single call, keeps the prefix and
// rewritePrefix in sync by default (the common case), and centralises the
// place to extend shared proxy behaviour in future (e.g. per-route auth,
// circuit breakers, or observability).

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
 * });
 * ```
 */
export function registerProxyRoute(app: FastifyInstance, options: ProxyRouteOptions): void {
  const { upstream, prefix, rewritePrefix = prefix, preHandler, replyOptions } = options;
  app.register(proxy, { upstream, prefix, rewritePrefix, preHandler, replyOptions });
}
