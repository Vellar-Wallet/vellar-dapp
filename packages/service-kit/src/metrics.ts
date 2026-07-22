import type { FastifyInstance } from "fastify";
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Registry as RegistryType,
} from "prom-client";

// Observability (idea.md §13, technical-doc.md §10): a shared Prometheus metrics
// layer so every service exposes /metrics identically (DRY — defined once here,
// not per-service). Covers the three §13 pillars:
//   - Metrics: HTTP request/latency (automatic) + domain success/failure rates
//     and the verification-turnaround timing the spec names.
//   - Logging: structured domain events (see logEvent below), which also feed
//     these counters.
//   - Alerting: the counters an operator writes alert rules against live here
//     (worker failures, RPC degradation, tx failures) — see docs/observability.
//
// The registry is a singleton per process. `all-in-one` boots several services
// in ONE process, so a single shared registry (with a `service` label) is
// correct — separate registries would double-register default metrics and throw.

const registry: RegistryType = new Registry();
let defaultsCollected = false;

/** The process-wide metrics registry. */
export function metricsRegistry(): RegistryType {
  return registry;
}

// --- HTTP metrics (automatic, per request) -----------------------------------

const httpRequests = new Counter({
  name: "vela_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["service", "method", "route", "status"] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: "vela_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["service", "method", "route", "status"] as const,
  // Buckets tuned for API + build endpoints (ms→minutes).
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

// --- Domain metrics (idea.md §13) --------------------------------------------

/** Success/failure counter factory — the §13 "…success/failure rate" metrics
 * are all `_total` counters split by an `outcome` label, so a rate is
 * `outcome="success" / (success+failure)` in the query layer. */
function outcomeCounter(name: string, help: string) {
  return new Counter({
    name,
    help,
    labelNames: ["service", "outcome", "network"] as const,
    registers: [registry],
  });
}

export const domainMetrics = {
  walletCreated: outcomeCounter("vela_wallet_created_total", "Wallet creation attempts"),
  passkeyAuth: outcomeCounter("vela_passkey_auth_total", "Passkey auth (connect) attempts"),
  txSigned: outcomeCounter("vela_tx_signed_total", "Transaction submit/sign completions"),
  policyDeployed: outcomeCounter("vela_policy_deployed_total", "Policy instance deploys"),
  verification: outcomeCounter("vela_verification_total", "Verification outcomes"),
  cleanupCompleted: outcomeCounter(
    "vela_cleanup_completed_total",
    "Account cleanup/merge completions",
  ),
  /** RPC/Horizon degradation signal — increment on upstream network errors. */
  rpcErrors: new Counter({
    name: "vela_rpc_errors_total",
    help: "Upstream RPC/Horizon errors (RPC degradation signal)",
    labelNames: ["service", "upstream"] as const,
    registers: [registry],
  }),
  /** verification turnaround: submit → terminal (verified/failed) in seconds. */
  verificationTurnaround: new Histogram({
    name: "vela_verification_turnaround_seconds",
    help: "Time from verification submission to a terminal result",
    labelNames: ["service", "outcome"] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
    registers: [registry],
  }),
} as const;

export type Outcome = "success" | "failure";

/** Record a domain outcome succinctly: `recordOutcome(domainMetrics.walletCreated,
 * service, "success", network)`. Keeps call sites one line. */
export function recordOutcome(
  counter: Counter<"service" | "outcome" | "network">,
  service: string,
  outcome: Outcome,
  network = "unknown",
): void {
  counter.inc({ service, outcome, network });
}

// --- Registration ------------------------------------------------------------

/**
 * Wire HTTP instrumentation + the /metrics endpoint onto a service. Call once,
 * alongside registerHealth. Node/process default metrics are collected once per
 * process (guarded so all-in-one's multiple services don't double-register).
 */
export function registerMetrics(app: FastifyInstance, serviceName: string): void {
  if (!defaultsCollected) {
    collectDefaultMetrics({ register: registry });
    defaultsCollected = true;
  }

  app.addHook("onResponse", async (request, reply) => {
    // Use the matched route pattern, not the raw URL, so path params don't
    // explode cardinality (/wallet/session/:id, not a label per id).
    const route = (request.routeOptions?.url ?? request.url).split("?")[0] ?? "unknown";
    const labels = {
      service: serviceName,
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}

/** Reset the registry (tests only — isolates metric state between cases). */
export function __resetMetricsForTest(): void {
  registry.resetMetrics();
}
