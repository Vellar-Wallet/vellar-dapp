import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server";

describe("api-gateway", () => {
  let app: FastifyInstance;
  let upstream: FastifyInstance;

  beforeAll(async () => {
    // Stand-in wallet-service so the proxy makes a real round trip.
    upstream = Fastify();
    upstream.post("/wallet/connect", async (request) => ({
      echoed: request.body,
      from: "wallet-service-stub",
    }));
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const { port } = upstream.server.address() as AddressInfo;

    app = buildServer({ walletServiceUrl: `http://127.0.0.1:${port}` });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await upstream.close();
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
});
