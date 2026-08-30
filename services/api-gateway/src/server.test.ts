import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
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

  it("never echoes a foreign origin back as allowed and rejects disallowed origins", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/wallet/connect",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sets security headers (helmet) on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    // API responses should not advertise a page CSP (disabled by design).
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("api-gateway circuit breaker for verification-service (#326)", () => {
  it("opens after consecutive connection failures, fast-fails with 503, then recovers", async () => {
    // A real upstream that starts closed (so calls hit a real ECONNREFUSED),
    // then gets started once we want to observe recovery — this exercises
    // the real fastify-http-proxy connection-failure path, not a simulated
    // error.
    const verificationUpstream = Fastify();
    verificationUpstream.get("/verification/ping", async () => ({ status: "verified" }));

    // Reserve a port, then immediately close it so it's guaranteed nothing
    // is listening there when the gateway starts making requests.
    const probe = Fastify();
    await probe.listen({ port: 0, host: "127.0.0.1" });
    const { port } = probe.server.address() as AddressInfo;
    await probe.close();

    const cbApp = buildServer({
      walletServiceUrl: "http://127.0.0.1:1",
      verificationServiceUrl: `http://127.0.0.1:${port}`,
      verificationCircuitFailureThreshold: 2,
      verificationCircuitCooldownMs: 200,
    });
    await cbApp.ready();

    try {
      // First 2 calls hit the real (nothing-listening) port and fail —
      // proxied as a connection-level error, not a 4xx/5xx from a real
      // server. The breaker counts these as failures.
      const first = await cbApp.inject({ method: "GET", url: "/verification/ping" });
      expect(first.statusCode).toBeGreaterThanOrEqual(500); // connection refused -> proxy error
      const second = await cbApp.inject({ method: "GET", url: "/verification/ping" });
      expect(second.statusCode).toBeGreaterThanOrEqual(500);

      // Breaker is now open (threshold 2) — the 3rd call must fast-fail with
      // the breaker's own 503, not attempt the network call at all.
      const third = await cbApp.inject({ method: "GET", url: "/verification/ping" });
      expect(third.statusCode).toBe(503);
      expect(third.json()).toMatchObject({ error: "verification_service_unavailable" });
      expect(third.json().retryAfterMs).toBeGreaterThan(0);

      // Start the real upstream and wait past the 200ms cooldown — the next
      // call should be allowed through as the half-open trial and succeed,
      // closing the breaker.
      await verificationUpstream.listen({ port, host: "127.0.0.1" });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const recovered = await cbApp.inject({ method: "GET", url: "/verification/ping" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({ status: "verified" });

      // Fully closed again — a normal subsequent call succeeds too.
      const afterRecovery = await cbApp.inject({ method: "GET", url: "/verification/ping" });
      expect(afterRecovery.statusCode).toBe(200);
    } finally {
      await cbApp.close();
      await verificationUpstream.close();
    }
  });

  it("does NOT count a normal upstream error response (4xx/5xx) as a breaker failure", async () => {
    const verificationUpstream = Fastify();
    verificationUpstream.get("/verification/always-404", async (_request, reply) => {
      return reply.code(404).send({ error: "not_found" });
    });
    await verificationUpstream.listen({ port: 0, host: "127.0.0.1" });
    const { port } = verificationUpstream.server.address() as AddressInfo;

    const cbApp = buildServer({
      walletServiceUrl: "http://127.0.0.1:1",
      verificationServiceUrl: `http://127.0.0.1:${port}`,
      verificationCircuitFailureThreshold: 1, // trips on the very first FAILURE — proves 404s aren't counted
      verificationCircuitCooldownMs: 60_000,
    });
    await cbApp.ready();

    try {
      // Several real 404s from a genuinely reachable upstream — none of
      // these should trip the breaker, since the connection itself
      // succeeded every time.
      for (let i = 0; i < 5; i++) {
        const res = await cbApp.inject({ method: "GET", url: "/verification/always-404" });
        expect(res.statusCode).toBe(404);
      }
      // Still reachable — if the breaker had (incorrectly) opened, this
      // would come back as our own 503 instead of the upstream's 404.
      const stillReachable = await cbApp.inject({ method: "GET", url: "/verification/always-404" });
      expect(stillReachable.statusCode).toBe(404);
    } finally {
      await cbApp.close();
      await verificationUpstream.close();
    }
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

describe("api-gateway structured request logging", () => {
  it("emits valid JSON logs with method, path, status, and duration for each entry", async () => {
    const rawLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        rawLines.push(chunk.toString());
        callback();
      },
    });

    const logApp = buildServer({
      logger: { level: "info", stream },
    });
    await logApp.ready();

    try {
      const res = await logApp.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);

      // Verify that log lines are emitted and can be parsed as valid JSON
      expect(rawLines.length).toBeGreaterThan(0);

      let foundRequestEntry = false;
      for (const line of rawLines) {
        // Must be parseable JSON
        const parsed = JSON.parse(line.trim());
        expect(typeof parsed).toBe("object");

        if (parsed.path === "/health") {
          foundRequestEntry = true;
          // Verify required fields: method, path, status, and duration
          expect(parsed.method).toBe("GET");
          expect(parsed.path).toBe("/health");
          expect(parsed.status).toBe(200);
          expect(typeof parsed.duration).toBe("number");
          expect(parsed.duration).toBeGreaterThanOrEqual(0);
        }
      }

      expect(foundRequestEntry).toBe(true);
    } finally {
      await logApp.close();
    }
  });
});

