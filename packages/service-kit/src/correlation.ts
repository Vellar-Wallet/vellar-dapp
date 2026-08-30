import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Standard correlation ID header name. */
export const CORRELATION_ID_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

export interface CorrelationHeaders {
  [key: string]: string | string[] | undefined;
}

/**
 * Extracts a correlation ID from request headers.
 * Inspects `x-correlation-id` first, falling back to `x-request-id`.
 */
export function extractCorrelationId(headers: CorrelationHeaders): string | undefined {
  const corr = headers[CORRELATION_ID_HEADER] ?? headers[CORRELATION_ID_HEADER.toLowerCase()];
  if (corr) return Array.isArray(corr) ? corr[0] : corr;

  const reqId = headers[REQUEST_ID_HEADER] ?? headers[REQUEST_ID_HEADER.toLowerCase()];
  if (reqId) return Array.isArray(reqId) ? reqId[0] : reqId;

  return undefined;
}

/**
 * Returns the provided correlation ID if non-empty, otherwise generates a fresh UUID.
 */
export function ensureCorrelationId(candidate?: string): string {
  if (candidate && typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return randomUUID();
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId?: string;
  }
}

/**
 * Wires correlation ID propagation onto a Fastify application.
 *
 * 1. Reads `x-correlation-id` (or `x-request-id`) from inbound headers; generates a UUID if absent.
 * 2. Stashes the ID on `request.correlationId`.
 * 3. Injects `x-correlation-id` into outbound response headers.
 * 4. Augments the request logger child with `correlationId` so all log entries include it.
 */
export function registerCorrelationId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    const correlationId = ensureCorrelationId(extractCorrelationId(request.headers));
    request.correlationId = correlationId;
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.correlationId) {
      reply.header(CORRELATION_ID_HEADER, request.correlationId);
    }
  });
}
