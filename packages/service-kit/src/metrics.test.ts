import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMetricsForTest,
  domainMetrics,
  lintMetricNames,
  logEvent,
  metricsRegistry,
  recordOutcome,
  registerHealth,
  registerMetrics,
  validateMetricName,
} from "./index";

beforeEach(() => __resetMetricsForTest());
afterEach(() => __resetMetricsForTest());

async function appWithMetrics(
  service = "test-service",
  addRoutes?: (app: ReturnType<typeof Fastify>) => void,
) {
  const app = Fastify();
  registerHealth(app, service);
  registerMetrics(app, service);
  addRoutes?.(app);
  await app.ready();
  return app;
}

describe("registerMetrics — /metrics endpoint", () => {
  it("exposes a Prometheus text exposition with the right content type", async () => {
    const app = await appWithMetrics();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    // Default process metrics are present.
    expect(res.body).toContain("process_cpu_user_seconds_total");
    await app.close();
  });

  it("records an HTTP request counter + duration for handled routes", async () => {
    const app = await appWithMetrics("svc-a", (a) => a.get("/ping", async () => ({ ok: true })));
    await app.inject({ method: "GET", url: "/ping" });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("vela_http_requests_total");
    // Labelled by service + route pattern + status.
    expect(res.body).toMatch(
      /vela_http_requests_total\{[^}]*service="svc-a"[^}]*route="\/ping"[^}]*status="200"[^}]*\}/,
    );
    expect(res.body).toContain("vela_http_request_duration_seconds");
    await app.close();
  });

  it("labels routes by pattern, not raw path (no id-cardinality explosion)", async () => {
    const app = await appWithMetrics("test-service", (a) =>
      a.get("/item/:id", async () => ({ ok: true })),
    );
    await app.inject({ method: "GET", url: "/item/abc" });
    await app.inject({ method: "GET", url: "/item/xyz" });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    // One series for the pattern, not two for abc/xyz.
    expect(res.body).toContain('route="/item/:id"');
    expect(res.body).not.toContain('route="/item/abc"');
    await app.close();
  });
});

describe("domain metrics", () => {
  it("recordOutcome increments the outcome counter with labels", async () => {
    const app = await appWithMetrics();
    recordOutcome(domainMetrics.walletCreated, "wallet-service", "success", "testnet");
    recordOutcome(domainMetrics.walletCreated, "wallet-service", "failure", "testnet");

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(/vela_wallet_created_total\{[^}]*outcome="success"[^}]*\}\s+1/);
    expect(res.body).toMatch(/vela_wallet_created_total\{[^}]*outcome="failure"[^}]*\}\s+1/);
    await app.close();
  });

  it("verification turnaround is a histogram observation", async () => {
    const app = await appWithMetrics();
    domainMetrics.verificationTurnaround.observe(
      { service: "worker-service", outcome: "verified" },
      12.5,
    );
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("vela_worker_verification_turnaround_seconds_bucket");
    expect(res.body).toMatch(/vela_worker_verification_turnaround_seconds_sum\{[^}]*\}\s+12\.5/);
    await app.close();
  });

  it("rpc errors counter tracks upstream degradation", async () => {
    const app = await appWithMetrics();
    domainMetrics.rpcErrors.inc({ service: "wallet-service", upstream: "relayer" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(/vela_rpc_errors_total\{[^}]*upstream="relayer"[^}]*\}\s+1/);
    await app.close();
  });

  it("worker queue depth and processing lag gauges track backpressure state", async () => {
    const app = await appWithMetrics();
    domainMetrics.workerQueueDepth.set({ service: "worker-service" }, 42);
    domainMetrics.workerProcessingLagSeconds.set({ service: "worker-service" }, 3.5);

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(/vela_worker_queue_depth\{[^}]*service="worker-service"[^}]*\}\s+42/);
    expect(res.body).toMatch(
      /vela_worker_processing_lag_seconds\{[^}]*service="worker-service"[^}]*\}\s+3\.5/,
    );
    await app.close();
  });
});

describe("metrics naming convention (Issue #300)", () => {
  it("validates metric names following vela_<subsystem>_<name>_<unit_or_type>", () => {
    expect(validateMetricName("vela_wallet_created_total").valid).toBe(true);
    expect(validateMetricName("vela_http_request_duration_seconds").valid).toBe(true);
    expect(validateMetricName("vela_worker_queue_depth").valid).toBe(true);
    expect(validateMetricName("vela_policy_poison_messages_total").valid).toBe(true);
    expect(validateMetricName("vela_worker_processing_lag_seconds").valid).toBe(true);

    // Invalid prefix
    expect(validateMetricName("custom_metric_total").valid).toBe(false);
    // Invalid suffix
    expect(validateMetricName("vela_wallet_count_unknown").valid).toBe(false);
    // Missing name or subsystem
    expect(validateMetricName("vela_total").valid).toBe(false);
  });

  it("lintMetricNames verifies all registered application metrics pass the convention", () => {
    const { valid, violations } = lintMetricNames(metricsRegistry());
    expect(violations).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe("logEvent", () => {
  it("logs the event name as both a field and the message", () => {
    const info = vi.fn();
    logEvent({ info }, "wallet.created", { contractId: "C123", network: "testnet" });
    expect(info).toHaveBeenCalledWith(
      { event: "wallet.created", contractId: "C123", network: "testnet" },
      "wallet.created",
    );
  });
});
