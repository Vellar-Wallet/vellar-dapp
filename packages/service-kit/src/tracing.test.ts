import { describe, it, expect, beforeEach } from "vitest";
import {
  extractTraceContext,
  injectTraceContext,
  withTraceSpan,
  TraceCollector,
} from "./tracing";

describe("distributed tracing module (#301)", () => {
  beforeEach(() => {
    TraceCollector.getInstance().clear();
  });

  it("extracts and injects trace headers across service boundaries", () => {
    const context = extractTraceContext({
      "x-trace-id": "trace-12345",
      "x-span-id": "span-67890",
    });

    expect(context.traceId).toBe("trace-12345");
    expect(context.spanId).toBe("span-67890");

    const injected = injectTraceContext(context);
    expect(injected["x-trace-id"]).toBe("trace-12345");
    expect(injected.traceparent).toContain("trace12345");
  });

  it("extracts trace context from W3C traceparent header", () => {
    const context = extractTraceContext({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });

    expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context.spanId).toBe("00f067aa0ba902b7");
  });

  it("records trace spans across multi-service deployment flow", async () => {
    const traceCtx = extractTraceContext({ "x-trace-id": "deploy-trace-999" });

    // Service 1: API Gateway
    await withTraceSpan("api-gateway", "proxy.policies.deploy", traceCtx, async (gwSpan) => {
      // Service 2: Policy Service
      const policyCtx = { traceId: gwSpan.traceId, spanId: gwSpan.spanId };
      await withTraceSpan("policy-service", "policy.deploy", policyCtx, async (psSpan) => {
        // Service 3: Worker Service
        const workerCtx = { traceId: psSpan.traceId, spanId: psSpan.spanId };
        await withTraceSpan("worker-service", "policy.execute", workerCtx, async () => {
          return { status: "deployed" };
        });
      });
    });

    const spans = TraceCollector.getInstance().getSpans("deploy-trace-999");
    expect(spans.length).toBe(3);

    const services = spans.map((s) => s.service);
    expect(services).toContain("worker-service");
    expect(services).toContain("policy-service");
    expect(services).toContain("api-gateway");

    for (const span of spans) {
      expect(span.traceId).toBe("deploy-trace-999");
      expect(span.status).toBe("ok");
      expect(span.endTimeMs).toBeGreaterThanOrEqual(span.startTimeMs);
    }
  });

  it("records error status when span operation throws", async () => {
    const traceCtx = extractTraceContext();

    await expect(
      withTraceSpan("policy-service", "failing-span", traceCtx, async () => {
        throw new Error("Deployment verification failed");
      }),
    ).rejects.toThrow("Deployment verification failed");

    const spans = TraceCollector.getInstance().getSpans(traceCtx.traceId);
    expect(spans.length).toBe(1);
    expect(spans[0].status).toBe("error");
    expect(spans[0].attributes.error).toBe("Deployment verification failed");
  });
});
