/**
 * Distributed tracing primitives and span context propagation helpers (#301).
 * Enables end-to-end trace visibility across service boundaries (api-gateway -> policy-service -> worker-service).
 */

import { randomUUID } from "node:crypto";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  startTimeMs: number;
  endTimeMs?: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId?: string;
}

export interface TraceHeaderMap {
  [key: string]: string | undefined;
}

export class TraceCollector {
  private static instance: TraceCollector;
  private readonly spans: TraceSpan[] = [];

  public static getInstance(): TraceCollector {
    if (!TraceCollector.instance) {
      TraceCollector.instance = new TraceCollector();
    }
    return TraceCollector.instance;
  }

  public recordSpan(span: TraceSpan): void {
    this.spans.push(span);
  }

  public getSpans(traceId?: string): TraceSpan[] {
    if (traceId) {
      return this.spans.filter((s) => s.traceId === traceId);
    }
    return [...this.spans];
  }

  public clear(): void {
    this.spans.length = 0;
  }
}

/**
 * Generate or extract a traceId from HTTP headers / metadata.
 */
export function extractTraceContext(headers?: TraceHeaderMap): TraceContext {
  if (!headers) {
    return { traceId: randomUUID() };
  }

  const rawTraceId =
    headers["x-trace-id"] ||
    headers["X-Trace-Id"] ||
    headers["x-request-id"] ||
    headers["X-Request-Id"];

  const rawTraceparent = headers["traceparent"] || headers["Traceparent"];

  if (rawTraceparent && typeof rawTraceparent === "string") {
    // W3C traceparent format: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
    const parts = rawTraceparent.split("-");
    if (parts.length >= 3 && parts[1]) {
      return { traceId: parts[1], spanId: parts[2] };
    }
  }

  if (rawTraceId && typeof rawTraceId === "string") {
    return { traceId: rawTraceId, spanId: headers["x-span-id"] as string | undefined };
  }

  return { traceId: randomUUID() };
}

/**
 * Inject trace context into outgoing HTTP headers or queue message metadata.
 */
export function injectTraceContext(
  context: TraceContext,
  headers: Record<string, string> = {},
): Record<string, string> {
  const spanId = context.spanId ?? randomUUID().slice(0, 16);
  return {
    ...headers,
    "x-trace-id": context.traceId,
    "x-span-id": spanId,
    traceparent: `00-${context.traceId.replace(/-/g, "")}-${spanId.slice(0, 16)}-01`,
  };
}

/**
 * Create and execute a traced span function, automatically recording timing and status.
 */
export async function withTraceSpan<T>(
  service: string,
  name: string,
  context: TraceContext,
  fn: (span: TraceSpan) => Promise<T>,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const spanId = randomUUID().slice(0, 16);
  const startTimeMs = Date.now();
  const span: TraceSpan = {
    traceId: context.traceId,
    spanId,
    parentSpanId: context.spanId,
    service,
    name,
    startTimeMs,
    status: "ok",
    attributes: { ...attributes },
  };

  try {
    const result = await fn(span);
    span.endTimeMs = Date.now();
    span.status = "ok";
    TraceCollector.getInstance().recordSpan(span);
    return result;
  } catch (err) {
    span.endTimeMs = Date.now();
    span.status = "error";
    span.attributes.error = err instanceof Error ? err.message : String(err);
    TraceCollector.getInstance().recordSpan(span);
    throw err;
  }
}
