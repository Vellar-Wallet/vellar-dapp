import { describe, expect, it, vi } from "vitest";
import { parseRequestCounts, runCanaryGate } from "./canary-error-budget-gate";

// A real sample of the exact text `registerMetrics` (@vellar/service-kit)
// produces, captured from a live buildServer() + prom-client scrape —
// verifying the parser against the real format, not a guessed one.
const SAMPLE_METRICS_TEXT = `
# HELP vela_http_requests_total Total HTTP requests
# TYPE vela_http_requests_total counter
vela_http_requests_total{service="api-gateway",method="GET",route="/health",status="200"} 42
vela_http_requests_total{service="api-gateway",method="POST",route="/wallet/create",status="200"} 18
vela_http_requests_total{service="api-gateway",method="POST",route="/wallet/create",status="503"} 3
vela_http_requests_total{service="api-gateway",method="GET",route="/wallet/list",status="500"} 1

# HELP vela_http_request_duration_seconds HTTP request duration in seconds
# TYPE vela_http_request_duration_seconds histogram
vela_http_request_duration_seconds_bucket{le="0.005",service="api-gateway",method="GET",route="/health",status="200"} 42
vela_http_request_duration_seconds_sum{service="api-gateway",method="GET",route="/health",status="200"} 0.12
vela_http_request_duration_seconds_count{service="api-gateway",method="GET",route="/health",status="200"} 42

# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total 0.02397
`;

describe("parseRequestCounts", () => {
  it("sums total requests and 5xx-status requests from a real Prometheus scrape", () => {
    const counts = parseRequestCounts(SAMPLE_METRICS_TEXT);
    expect(counts.total).toBe(42 + 18 + 3 + 1);
    expect(counts.serverErrors).toBe(3 + 1); // the 503 and the 500 lines
  });

  it("ignores non-request-counter metric families (histograms, process metrics)", () => {
    const counts = parseRequestCounts(SAMPLE_METRICS_TEXT);
    // If duration_seconds_count or process_cpu lines were miscounted as
    // requests, total would be inflated well past 64.
    expect(counts.total).toBe(64);
  });

  it("returns zero counts for an empty or metric-less scrape", () => {
    expect(parseRequestCounts("")).toEqual({ total: 0, serverErrors: 0 });
    expect(parseRequestCounts("# just comments\n")).toEqual({ total: 0, serverErrors: 0 });
  });

  it("does not count 4xx or 2xx statuses as server errors", () => {
    const text = [
      'vela_http_requests_total{service="x",method="GET",route="/a",status="400"} 5',
      'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 10',
    ].join("\n");
    const counts = parseRequestCounts(text);
    expect(counts.total).toBe(15);
    expect(counts.serverErrors).toBe(0);
  });
});

describe("runCanaryGate", () => {
  function fetchReturning(texts: string[]) {
    let i = 0;
    return vi.fn(async () => {
      const text = texts[Math.min(i, texts.length - 1)];
      i++;
      return { ok: true, status: 200, text: async () => text } as Response;
    });
  }

  it("passes when the error rate over the window is within budget", async () => {
    const before = 'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 100';
    const after = [
      'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 195',
      'vela_http_requests_total{service="x",method="GET",route="/a",status="500"} 5',
    ].join("\n");

    const result = await runCanaryGate({
      url: "http://canary",
      maxErrorRate: 0.05,
      minRequests: 10,
      fetchImpl: fetchReturning([before, after]),
      sleepImpl: async () => {},
    });

    expect(result.inconclusive).toBe(false);
    expect(result.requestsInWindow).toBe(100); // (195+5) - 100
    expect(result.serverErrorsInWindow).toBe(5);
    expect(result.errorRate).toBeCloseTo(0.05);
    expect(result.ok).toBe(true);
  });

  it("fails when the error rate exceeds the budget", async () => {
    const before = 'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 0';
    const after = [
      'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 80',
      'vela_http_requests_total{service="x",method="GET",route="/a",status="500"} 20',
    ].join("\n");

    const result = await runCanaryGate({
      url: "http://canary",
      maxErrorRate: 0.05,
      minRequests: 10,
      fetchImpl: fetchReturning([before, after]),
      sleepImpl: async () => {},
    });

    expect(result.errorRate).toBeCloseTo(0.2);
    expect(result.ok).toBe(false);
  });

  it("is inconclusive (but not a failure) when too few requests occurred in the window", async () => {
    const before = 'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 100';
    const after = 'vela_http_requests_total{service="x",method="GET",route="/a",status="500"} 103'; // only 3 new requests, all errors

    const result = await runCanaryGate({
      url: "http://canary",
      maxErrorRate: 0.01,
      minRequests: 10,
      fetchImpl: fetchReturning([before, after]),
      sleepImpl: async () => {},
    });

    expect(result.inconclusive).toBe(true);
    expect(result.ok).toBe(true); // inconclusive is not treated as failing
  });

  it("treats a counter reset between scrapes (process restart) as a fresh window rather than a negative delta", async () => {
    const before = 'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 500';
    // Counters dropped below the "before" value — the service restarted.
    const after = 'vela_http_requests_total{service="x",method="GET",route="/a",status="200"} 40';

    const result = await runCanaryGate({
      url: "http://canary",
      minRequests: 10,
      fetchImpl: fetchReturning([before, after]),
      sleepImpl: async () => {},
    });

    expect(result.requestsInWindow).toBe(40);
    expect(result.errorRate).toBe(0);
  });

  it("waits windowMs between the two scrapes", async () => {
    const sleepImpl = vi.fn(async () => {});
    await runCanaryGate({
      url: "http://canary",
      windowMs: 30_000,
      minRequests: 0,
      fetchImpl: fetchReturning(["", ""]),
      sleepImpl,
    });
    expect(sleepImpl).toHaveBeenCalledWith(30_000);
  });
});
