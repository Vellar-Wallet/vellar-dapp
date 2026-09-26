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
    const app = buildServer({
      tenantBucketCapacity: 3,
      tenantBucketRefillRate: 1,
    });

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/health",
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
  });
});
