import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server";

describe("api-gateway", () => {
  let app: FastifyInstance;
  let upstream: FastifyInstance;
  let verificationUpstream: FastifyInstance;

  beforeAll(async () => {
    // Stand-in wallet-service so the proxy makes a real round trip.
    upstream = Fastify();
    upstream.post("/wallet/connect", async (request) => ({
      echoed: request.body,
      from: "wallet-service-stub",
    }));
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const { port } = upstream.server.address() as AddressInfo;

    // Stand-in verification-service on its own upstream.
    verificationUpstream = Fastify();
    verificationUpstream.get("/verification/:contractId/status", async (request) => ({
      contractId: (request.params as { contractId: string }).contractId,
      status: "verified",
      from: "verification-service-stub",
    }));
    await verificationUpstream.listen({ port: 0, host: "127.0.0.1" });
    const { port: verifyPort } = verificationUpstream.server.address() as AddressInfo;

    app = buildServer({
      walletServiceUrl: `http://127.0.0.1:${port}`,
      verificationServiceUrl: `http://127.0.0.1:${verifyPort}`,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await upstream.close();
    await verificationUpstream.close();
  });

  it("responds ok on /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "api-gateway" });
  });

  it("proxies /wallet/* to the wallet service with the request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: "key-1", network: "testnet" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      echoed: { keyId: "key-1", network: "testnet" },
      from: "wallet-service-stub",
    });
  });

  it("proxies /verification/* to the verification service", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/verification/CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67/status",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "verified", from: "verification-service-stub" });
  });

  it("propagates upstream errors instead of masking them", async () => {
    const res = await app.inject({ method: "POST", url: "/wallet/unknown-route", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("404s on routes outside the proxied prefixes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("allows the configured web-app origin via CORS", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/wallet/connect",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("preflight allows DELETE (session revocation)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/wallet/session/some-id",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "DELETE",
      },
    });
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("never echoes a foreign origin back as allowed", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/wallet/connect",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    // With a static origin config the header is always the configured origin;
    // browsers block the caller when it doesn't match their own.
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
  });

  it("sets security headers (helmet) on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    // API responses should not advertise a page CSP (disabled by design).
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("api-gateway security controls", () => {
  let secApp: FastifyInstance;
  let upstream: FastifyInstance;

  beforeAll(async () => {
    upstream = Fastify();
    upstream.post("/wallet/connect", async (request) => ({ ok: true, echoed: request.body }));
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const { port } = upstream.server.address() as AddressInfo;

    secApp = buildServer({
      walletServiceUrl: `http://127.0.0.1:${port}`,
      // Tight limits so the tests trip them quickly.
      rateLimitMax: 3,
      rateLimitWindowMs: 60_000,
      maxBodyBytes: 256,
    });
    await secApp.ready();
  });

  afterAll(async () => {
    await secApp.close();
    await upstream.close();
  });

  it("rate-limits per IP after the configured max (429)", async () => {
    const hit = () =>
      secApp.inject({
        method: "POST",
        url: "/wallet/connect",
        payload: { keyId: "k", network: "testnet" },
      });
    // 3 allowed, the 4th is throttled.
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const throttled = await hit();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("does NOT rate-limit /health (liveness probes stay unthrottled)", async () => {
    // Far more than the limit — all should pass because /health is allow-listed.
    for (let i = 0; i < 10; i++) {
      const res = await secApp.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects a mutation without a JSON content-type (415) — CSRF mitigation", async () => {
    const res = await secApp.inject({
      method: "POST",
      url: "/wallet/connect",
      headers: { "content-type": "text/plain" },
      payload: "keyId=k",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("unsupported_media_type");
  });

  it("rejects an over-limit request body (413)", async () => {
    // Fresh instance with a generous rate limit so ONLY the body cap can trip
    // (the shared-IP rate-limit budget is already spent by the 429 test above).
    const bodyApp = buildServer({
      walletServiceUrl: "http://127.0.0.1:1", // never reached; body cap fires first
      rateLimitMax: 1000,
      maxBodyBytes: 256,
    });
    await bodyApp.ready();
    try {
      const big = { blob: "x".repeat(1000) }; // > 256-byte maxBodyBytes
      const res = await bodyApp.inject({ method: "POST", url: "/wallet/connect", payload: big });
      expect(res.statusCode).toBe(413);
    } finally {
      await bodyApp.close();
    }
  });
});
