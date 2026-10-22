import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./token-bucket";
import { buildServer } from "./server";

describe("TokenBucketLimiter (#259)", () => {
  it("allows bursts up to capacity and blocks afterwards", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 5,
      refillRatePerSecond: 1,
    });

    for (let i = 0; i < 5; i++) {
      const res = limiter.tryConsume("tenant-1");
      expect(res.allowed).toBe(true);
    }

    const blocked = limiter.tryConsume("tenant-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("isolates different tenants", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillRatePerSecond: 1,
    });

    expect(limiter.tryConsume("tenant-A").allowed).toBe(true);
    expect(limiter.tryConsume("tenant-A").allowed).toBe(true);
    expect(limiter.tryConsume("tenant-A").allowed).toBe(false);

    // Tenant B is unaffected
    expect(limiter.tryConsume("tenant-B").allowed).toBe(true);
    expect(limiter.tryConsume("tenant-B").allowed).toBe(true);
  });

  it("returns 429 and Retry-After header when tenant rate limit is exceeded in gateway", async () => {
    const upstream = Fastify();
    upstream.get("/policies/test-id", async () => ({ ok: true }));
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const port = (upstream.server.address() as AddressInfo).port;

    const app = buildServer({
      policyServiceUrl: `http://127.0.0.1:${port}`,
      tenantBucketCapacity: 3,
      tenantBucketRefillRate: 1,
    });

    try {
      // 3 warm-up requests to a non-exempt route consume 3 tokens
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/policies/test-id",
          headers: { "x-tenant-id": "tenant-test" },
        });
        expect(res.statusCode).toBe(200);
      }

      // Next request to non-health endpoint trips rate limit
      const res = await app.inject({
        method: "GET",
        url: "/policies/test-id",
        headers: { "x-tenant-id": "tenant-test" },
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      const body = JSON.parse(res.body);
      expect(body.error).toBe("too_many_requests");
    } finally {
      await upstream.close();
    }
  });

  it("regression: unreachable upstream returns 500 when within rate limit capacity, not conflated with 429", async () => {
    const app = buildServer({
      policyServiceUrl: "http://127.0.0.1:59999",
      tenantBucketCapacity: 10,
      tenantBucketRefillRate: 1,
    });

    const res = await app.inject({
      method: "GET",
      url: "/policies/test-id",
      headers: { "x-tenant-id": "tenant-unreachable" },
    });

    // Gateway proxy failure surfaces as 500, definitely not 429
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).not.toBe(429);
  });
});
