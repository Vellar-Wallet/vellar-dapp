import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  assertErrorEnvelopeForRoute,
  GATEWAY_ERROR_ENVELOPE_ROUTES,
  isErrorEnvelope,
  registerErrorEnvelope,
} from "./error-envelope";
import { buildServer } from "./server";

describe("error-envelope — route-wide conformance (#545)", () => {
  it("triggers known error conditions across every registered route and asserts the ErrorEnvelope shape", async () => {
    const app = buildServer({
      walletServiceUrl: "http://127.0.0.1:1",
      lifecycleServiceUrl: "http://127.0.0.1:1",
      policyServiceUrl: "http://127.0.0.1:1",
      verificationServiceUrl: "http://127.0.0.1:1",
      rateLimitMax: 1000,
      maxBodyBytes: 64,
      tenantBucketCapacity: 1,
      tenantBucketRefillRate: 0.001,
    });
    await app.ready();

    try {
      for (const routePrefix of GATEWAY_ERROR_ENVELOPE_ROUTES) {
        const targetUrl = `${routePrefix}/test-action`;

        // 1. 415 Unsupported Media Type on non-JSON mutation
        const res415 = await app.inject({
          method: "POST",
          url: targetUrl,
          headers: { "content-type": "text/plain" },
          payload: "plain-text",
        });
        expect(res415.statusCode).toBe(415);
        const env415 = assertErrorEnvelopeForRoute(`POST ${targetUrl} (415)`, res415.json());
        expect(env415.error.code).toBe("unsupported_media_type");

        // 2. 413 Payload Too Large on oversized mutation
        const res413 = await app.inject({
          method: "POST",
          url: targetUrl,
          headers: { "content-type": "application/json" },
          payload: { oversized: "x".repeat(128) },
        });
        expect(res413.statusCode).toBe(413);
        const env413 = assertErrorEnvelopeForRoute(`POST ${targetUrl} (413)`, res413.json());
        expect(env413.error.code).toBe("payload_too_large");

        // 3. 429 Too Many Requests on exhausted tenant token bucket
        const tenantId = `tenant-for-${routePrefix}`;
        await app.inject({
          method: "POST",
          url: targetUrl,
          headers: { "x-tenant-id": tenantId, "content-type": "text/plain" },
          payload: "x",
        });
        const res429 = await app.inject({
          method: "GET",
          url: targetUrl,
          headers: { "x-tenant-id": tenantId },
        });
        expect(res429.statusCode).toBe(429);
        const env429 = assertErrorEnvelopeForRoute(`GET ${targetUrl} (429)`, res429.json());
        expect(env429.error.code).toBe("too_many_requests");
        expect(env429.error.details).toMatchObject({
          retryAfter: expect.any(Number),
        });
      }

      // 4. 404 Not Found on unmapped route outside registered prefixes
      const res404 = await app.inject({
        method: "GET",
        url: "/unregistered/route",
      });
      expect(res404.statusCode).toBe(404);
      const env404 = assertErrorEnvelopeForRoute("GET /unregistered/route (404)", res404.json());
      expect(env404.error.code).toBe("not_found");
    } finally {
      await app.close();
    }
  });

  it("wraps uncaught route errors and IP rate-limit errors in the standard ErrorEnvelope", async () => {
    const app = Fastify({ logger: false });
    registerErrorEnvelope(app);
    app.get("/boom", async () => {
      throw new Error("sensitive internal stack detail");
    });
    app.get("/rate-limited", async (_req, reply) => {
      reply.header("Retry-After", "15");
      const err = new Error("Rate limit exceeded") as Error & { statusCode?: number };
      err.statusCode = 429;
      throw err;
    });
    await app.ready();

    try {
      const boomRes = await app.inject({ method: "GET", url: "/boom" });
      expect(boomRes.statusCode).toBe(500);
      const boomEnv = assertErrorEnvelopeForRoute("GET /boom", boomRes.json());
      expect(boomEnv).toEqual({
        error: {
          code: "internal_error",
          message: "An internal error occurred.",
        },
      });

      const rateRes = await app.inject({ method: "GET", url: "/rate-limited" });
      expect(rateRes.statusCode).toBe(429);
      const rateEnv = assertErrorEnvelopeForRoute("GET /rate-limited", rateRes.json());
      expect(rateEnv).toEqual({
        error: {
          code: "too_many_requests",
          message: "Too many requests. Please retry later.",
          details: { retryAfter: "15" },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("fails clearly and names the offending route when an error payload does not conform", () => {
    const legacyFlatShape = { error: "bad_request", reason: "missing field" };
    const missingMessageShape = { error: { code: "bad_request" } };
    const extraTopLevelFieldShape = {
      error: { code: "bad_request", message: "Bad request" },
      retryAfter: 10,
    };

    expect(isErrorEnvelope(legacyFlatShape)).toBe(false);
    expect(isErrorEnvelope(missingMessageShape)).toBe(false);
    expect(isErrorEnvelope(extraTopLevelFieldShape)).toBe(false);

    expect(() => assertErrorEnvelopeForRoute("POST /v1/policies/deploy", legacyFlatShape)).toThrow(
      /Route "POST \/v1\/policies\/deploy" returned an error response that does not match ErrorEnvelope/,
    );
    expect(() => assertErrorEnvelopeForRoute("GET /wallet/session", missingMessageShape)).toThrow(
      /Route "GET \/wallet\/session"/,
    );
  });
});
