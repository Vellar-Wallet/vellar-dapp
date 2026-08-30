import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Default CSRF token validity duration: 1 hour in milliseconds. */
export const DEFAULT_CSRF_TTL_MS = 60 * 60 * 1000;

export interface CsrfOptions {
  secret: string;
  ttlMs?: number;
}

export interface CsrfVerificationResult {
  valid: boolean;
  reason?: "missing" | "malformed" | "expired" | "invalid_signature";
}

/**
 * Generates an HMAC-signed, time-bounded CSRF token.
 * Format: `<nonce>.<timestampMs>.<signature>`
 */
export function generateCsrfToken(secret: string, nowMs = Date.now()): string {
  const nonce = randomUUID();
  const timestamp = nowMs.toString();
  const data = `${nonce}.${timestamp}`;
  const sig = createHmac("sha256", secret).update(data).digest("hex");
  return `${nonce}.${timestamp}.${sig}`;
}

/**
 * Validates an HMAC-signed CSRF token.
 * Enforces signature validity using timing-safe comparison and checks token freshness against TTL.
 */
export function verifyCsrfToken(
  token: string | undefined,
  secret: string,
  opts: { nowMs?: number; ttlMs?: number } = {},
): CsrfVerificationResult {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return { valid: false, reason: "missing" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed" };
  }

  const [nonce, timestampStr, sig] = parts;
  if (!nonce || !timestampStr || !sig) {
    return { valid: false, reason: "malformed" };
  }

  const timestampMs = Number(timestampStr);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { valid: false, reason: "malformed" };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_CSRF_TTL_MS;
  if (nowMs - timestampMs > ttlMs || timestampMs > nowMs + 60_000) {
    return { valid: false, reason: "expired" };
  }

  const data = `${nonce}.${timestampStr}`;
  const expectedSig = createHmac("sha256", secret).update(data).digest("hex");

  const sigBuffer = Buffer.from(sig, "hex");
  const expectedBuffer = Buffer.from(expectedSig, "hex");

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

/**
 * Fastify preHandler hook enforcing CSRF token validation on state-changing methods.
 */
export function createCsrfPreHandler(options: CsrfOptions) {
  return async function csrfPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    if (!isMutation) return;

    const rawToken =
      (request.headers["x-csrf-token"] as string | undefined) ??
      (request.headers["csrf-token"] as string | undefined);

    if (!rawToken) {
      return reply.code(403).send({
        error: "csrf_token_missing",
        message: "CSRF token is required for state-changing admin routes",
      });
    }

    const result = verifyCsrfToken(rawToken, options.secret, { ttlMs: options.ttlMs });
    if (!result.valid) {
      return reply.code(403).send({
        error: "csrf_token_invalid",
        message:
          result.reason === "expired"
            ? "CSRF token has expired"
            : "Invalid or tampered CSRF token",
        reason: result.reason,
      });
    }
  };
}
