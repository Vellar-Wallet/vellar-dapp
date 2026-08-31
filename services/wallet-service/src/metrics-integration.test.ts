import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { __resetMetricsForTest } from "@vellar/service-kit";
import { buildServer } from "./server";
import { createUnconfiguredSubmitter } from "./relayer";
import { createMemoryWalletRepository, createMemorySessionRepository } from "./repository";

describe("Cache Metrics Integration (/metrics endpoint)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    __resetMetricsForTest();
    app = buildServer({
      submitter: createUnconfiguredSubmitter(),
      wallets: createMemoryWalletRepository(),
      sessions: createMemorySessionRepository(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("exposes cache metrics via /metrics endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");

    const metrics = response.body;
    expect(metrics).toContain("wallet_service_cache_hits_total");
    expect(metrics).toContain("wallet_service_cache_misses_total");
  });

  it("returns metrics in Prometheus text format", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    const metrics = response.body;
    // Prometheus format includes HELP and TYPE comments
    expect(metrics).toMatch(/# HELP wallet_service_cache_hits_total/);
    expect(metrics).toMatch(/# TYPE wallet_service_cache_hits_total counter/);
    expect(metrics).toMatch(/# HELP wallet_service_cache_misses_total/);
    expect(metrics).toMatch(/# TYPE wallet_service_cache_misses_total counter/);
  });

  it("includes resource labels in metrics", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    const metrics = response.body;
    // After initialization, counters should be present (even at zero)
    expect(metrics).toContain('wallet_service_cache_hits_total{resource=');
    expect(metrics).toContain('wallet_service_cache_misses_total{resource=');
  });

  it("maintains separate counters for different resource types", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    const metrics = response.body;
    // Should have entries for each allowed resource type
    expect(metrics).toContain('resource="balance"');
    expect(metrics).toContain('resource="nonce"');
    expect(metrics).toContain('resource="account"');
    expect(metrics).toContain('resource="tx-history"');
  });

  it("includes standard HTTP metrics along with cache metrics", async () => {
    // Make a request so HTTP metrics get recorded
    await app.inject({
      method: "GET",
      url: "/health",
    });

    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    const metrics = response.body;
    // Should have both cache metrics and standard HTTP metrics
    expect(metrics).toContain("wallet_service_cache_hits_total");
    expect(metrics).toContain("vela_http_requests_total");
    expect(metrics).toContain("vela_http_request_duration_seconds");
  });

  it("does not expose PII or sensitive labels in metrics", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    const metrics = response.body;
    // Should NOT contain wallet addresses, user IDs, or request IDs
    expect(metrics).not.toContain("C");
    expect(metrics).not.toContain("keyId");
    expect(metrics).not.toContain("contractId");
  });

  it("metrics endpoint is accessible without authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(response.statusCode).toBe(200);
  });

  it("health endpoint does not interfere with metrics", async () => {
    // First check health
    const healthRes = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(healthRes.statusCode).toBe(200);

    // Then check metrics still work
    const metricsRes = await app.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metricsRes.statusCode).toBe(200);
  });
});
