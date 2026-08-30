import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  ensureCorrelationId,
  extractCorrelationId,
  registerCorrelationId,
} from "./correlation";

describe("correlation ID utilities", () => {
  it("extracts correlation ID from x-correlation-id", () => {
    const id = extractCorrelationId({ [CORRELATION_ID_HEADER]: "test-corr-123" });
    expect(id).toBe("test-corr-123");
  });

  it("extracts correlation ID from x-request-id fallback", () => {
    const id = extractCorrelationId({ [REQUEST_ID_HEADER]: "test-req-456" });
    expect(id).toBe("test-req-456");
  });

  it("extractCorrelationId returns undefined when no ID header exists", () => {
    const id = extractCorrelationId({ "content-type": "application/json" });
    expect(id).toBeUndefined();
  });

  it("ensureCorrelationId preserves existing ID or generates a valid UUID", () => {
    expect(ensureCorrelationId("my-custom-id")).toBe("my-custom-id");
    const generated = ensureCorrelationId();
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("registerCorrelationId Fastify plugin", () => {
  it("propagates inbound x-correlation-id to request and response headers", async () => {
    const app = Fastify();
    registerCorrelationId(app);
    app.get("/test", async (req) => ({ correlationId: req.correlationId }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-correlation-id": "client-correlation-789" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-correlation-id"]).toBe("client-correlation-789");
    expect(res.json().correlationId).toBe("client-correlation-789");
    await app.close();
  });

  it("generates a new correlation ID if none provided in request", async () => {
    const app = Fastify();
    registerCorrelationId(app);
    app.get("/test", async (req) => ({ correlationId: req.correlationId }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(200);
    const id = res.headers["x-correlation-id"] as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(res.json().correlationId).toBe(id);
    await app.close();
  });
});
