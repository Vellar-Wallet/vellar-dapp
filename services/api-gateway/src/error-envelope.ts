import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

// Standardized error envelope for every response this gateway sends directly
// (as opposed to a proxied upstream response, which is forwarded unchanged —
// see registerProxyRoute's replyOptions.onError, which sends the upstream's
// own error body). Issue #262: error shapes across this file's own
// hand-written error responses (rate limit, content-type rejection, circuit
// breaker) were three different ad-hoc shapes ({error, message, retryAfter},
// {error, reason}, {error, reason, retryAfterMs}), so client-side error
// handling could not rely on a single field name across routes.
//
// Process for adding error-envelope coverage when registering a new route (#545):
// 1. Add the new route's unversioned and `/v1` prefixes to
//    `GATEWAY_ERROR_ENVELOPE_ROUTES` below.
// 2. Ensure any route-specific preHandler or error path sends errors via
//    `sendError(reply, statusCode, code, message, details)`.
// 3. Run `error-envelope.test.ts`, which iterates over every entry in
//    `GATEWAY_ERROR_ENVELOPE_ROUTES`, triggers deterministic gateway error
//    conditions on each route, and calls `assertErrorEnvelopeForRoute(route, body)`
//    so any non-conforming route fails the suite by name.

export const GATEWAY_ERROR_ENVELOPE_ROUTES = [
  "/wallet",
  "/v1/wallet",
  "/lifecycle",
  "/v1/lifecycle",
  "/policies",
  "/v1/policies",
  "/verification",
  "/v1/verification",
] as const;

export type GatewayErrorEnvelopeRoute = (typeof GATEWAY_ERROR_ENVELOPE_ROUTES)[number];

export interface ErrorEnvelope {
  error: {
    /** Stable, machine-readable identifier — the same string every prior
     * ad-hoc shape used as its `error` field, kept as-is so no client-visible
     * error code changes, only the shape wrapping it. */
    code: string;
    /** Human-readable summary, safe to display or log. */
    message: string;
    /** Optional structured context (e.g. retryAfter, validation issues).
     * Absent entirely when there is nothing beyond code/message, rather than
     * an empty object every time. */
    details?: Record<string, unknown>;
  };
}

const ALLOWED_ENVELOPE_KEYS = new Set(["code", "message", "details"]);

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || topKeys[0] !== "error") return false;

  const err = (value as { error?: unknown }).error;
  if (typeof err !== "object" || err === null || Array.isArray(err)) return false;

  const errRecord = err as Record<string, unknown>;
  for (const key of Object.keys(errRecord)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) return false;
  }

  if (typeof errRecord.code !== "string" || errRecord.code.trim().length === 0) return false;
  if (typeof errRecord.message !== "string" || errRecord.message.trim().length === 0) return false;
  if (
    errRecord.details !== undefined &&
    (typeof errRecord.details !== "object" ||
      errRecord.details === null ||
      Array.isArray(errRecord.details))
  ) {
    return false;
  }

  return true;
}

/**
 * Validates that `body` conforms to the documented `ErrorEnvelope` shape and
 * throws an error naming `route` if it does not (#545).
 */
export function assertErrorEnvelopeForRoute(route: string, body: unknown): ErrorEnvelope {
  if (!isErrorEnvelope(body)) {
    throw new Error(
      `Route "${route}" returned an error response that does not match ErrorEnvelope ({ error: { code, message, details? } }): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

/** Sends a standardized error envelope. `code` and `message` are required;
 * `details` is optional structured context specific to that error. */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  const body: ErrorEnvelope = details
    ? { error: { code, message, details } }
    : { error: { code, message } };
  return reply.code(statusCode).send(body);
}

/** Registers the two global handlers that standardize errors this gateway
 * itself generates rather than proxies through: the 404 for a route outside
 * every proxied prefix, and any otherwise-uncaught error (a plugin default,
 * e.g. @fastify/rate-limit's own 429 body, or an unexpected thrown error). */
export function registerErrorEnvelope(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, "not_found", `No route matches ${request.method} ${request.url}`);
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    // @fastify/rate-limit's default errorResponseBuilder throws a plain
    // Error with only `.statusCode` set (429, or 403 once the caller is
    // banned for exceeding the limit repeatedly) — no `.code`, and the
    // Retry-After value is already on the response header (set before the
    // throw), not a property of the error itself. 429 is unambiguously the
    // rate limiter; 403 is left generic (not narrowed to "too_many_requests")
    // since this gateway may gain other genuine-403 sources later and
    // conflating them here would mislabel those. Everything else gets a
    // generic envelope so an unexpected internal error message is never
    // leaked verbatim to the client.
    const isRateLimited = statusCode === 429;
    const code = isRateLimited ? "too_many_requests" : "internal_error";
    const message = isRateLimited
      ? "Too many requests. Please retry later."
      : "An internal error occurred.";
    const retryAfterHeader = reply.getHeader("retry-after");
    const details =
      isRateLimited && retryAfterHeader !== undefined
        ? { retryAfter: retryAfterHeader }
        : undefined;
    sendError(reply, statusCode, code, message, details);
  });
}
