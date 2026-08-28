import type { FastifyInstance } from "fastify";
import {
  Counter,
  Gauge,
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

// --- Metrics Naming Convention (Issue #300) ---------------------------------
// Standard format: vela_<subsystem>_<metric_name>_<unit_or_type>
// e.g. vela_wallet_created_total, vela_http_request_duration_seconds

export const METRIC_NAMING_CONVENTION = {
  prefix: "vela",
  pattern: /^vela_([a-z0-9]+)_([a-z0-9_]+)_(total|seconds|bytes|depth|count|ratio|info|status|lag_seconds)$/,
  allowedSuffixes: [
    "total",
    "seconds",
    "bytes",
    "depth",
    "count",
    "ratio",
    "info",
    "status",
    "lag_seconds",
  ] as const,
  exampleFormat: "vela_<subsystem>_<metric_name>_<unit_or_suffix>",
} as const;

export interface MetricValidationResult {
  valid: boolean;
  reason?: string;
  parts?: {
    prefix: string;
    subsystem: string;
    name: string;
    suffix: string;
  };
}

/**
 * Validates a metric name against the shared Vellar convention:
 * `vela_<subsystem>_<metric_name>_<unit_or_suffix>`.
 */
export function validateMetricName(name: string): MetricValidationResult {
  if (!name.startsWith("vela_")) {
    return { valid: false, reason: "Metric name must start with 'vela_'" };
  }
  const match = METRIC_NAMING_CONVENTION.pattern.exec(name);
  if (!match) {
    return {
      valid: false,
      reason:
        `Metric name '${name}' does not follow convention '${METRIC_NAMING_CONVENTION.exampleFormat}'. ` +
        `Allowed suffixes: ${METRIC_NAMING_CONVENTION.allowedSuffixes.join(", ")}`,
    };
  }
  return {
    valid: true,
    parts: {
      prefix: "vela",
      subsystem: match[1]!,
      name: match[2]!,
      suffix: match[3]!,
    },
  };
}

/**
 * Asserts that a metric name adheres to the standard naming convention, throwing an Error if invalid.
 */
export function assertMetricName(name: string): void {
  const result = validateMetricName(name);
  if (!result.valid) {
    throw new Error(result.reason);
  }
}

/**
 * Lints all application metrics (starting with 'vela_') registered in a Prometheus registry.
 */
export function lintMetricNames(reg: RegistryType = registry): {
  valid: boolean;
  violations: Array<{ name: string; reason: string }>;
} {
  const metrics = reg.getMetricsAsArray();
  const violations: Array<{ name: string; reason: string }> = [];
  for (const m of metrics) {
    if (m.name.startsWith("vela_")) {
      const res = validateMetricName(m.name);
      if (!res.valid) {
        violations.push({ name: m.name, reason: res.reason ?? "Invalid metric name format" });
      }
    }
  }
  return { valid: violations.length === 0, violations };
}

// --- Domain metrics (idea.md §13, standardized under Issue #300) ------------

/** Success/failure counter factory — the §13 "…success/failure rate" metrics
 * are all `_total` counters split by an `outcome` label, so a rate is
 * `outcome="success" / (success+failure)` in the query layer. */
function outcomeCounter(name: string, help: string) {
  assertMetricName(name);
  return new Counter({
    name,
    help,
    labelNames: ["service", "outcome", "network"] as const,
    registers: [registry],
  });
}

const walletCreated = outcomeCounter("vela_wallet_created_total", "Wallet creation attempts");
const walletPasskeyAuth = outcomeCounter("vela_wallet_passkey_auth_total", "Passkey auth (connect) attempts");
const walletTxSigned = outcomeCounter("vela_wallet_tx_signed_total", "Transaction submit/sign completions");
const policyDeployed = outcomeCounter("vela_policy_deployed_total", "Policy instance deploys");
const policyPoisonMessages = outcomeCounter("vela_policy_poison_messages_total", "Quarantined poison messages");
const workerVerification = outcomeCounter("vela_worker_verification_total", "Verification outcomes");
const lifecycleCleanupCompleted = outcomeCounter(
  "vela_lifecycle_cleanup_completed_total",
  "Account cleanup/merge completions",
);

const rpcErrors = new Counter({
  name: "vela_rpc_errors_total",
  help: "Upstream RPC/Horizon errors (RPC degradation signal)",
  labelNames: ["service", "upstream"] as const,
  registers: [registry],
});
assertMetricName("vela_rpc_errors_total");

const workerVerificationTurnaround = new Histogram({
  name: "vela_worker_verification_turnaround_seconds",
  help: "Time from verification submission to a terminal result",
  labelNames: ["service", "outcome"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});
assertMetricName("vela_worker_verification_turnaround_seconds");

const workerQueueDepth = new Gauge({
  name: "vela_worker_queue_depth",
  help: "Number of pending verification jobs in queue",
  labelNames: ["service"] as const,
  registers: [registry],
});
assertMetricName("vela_worker_queue_depth");

const workerProcessingLagSeconds = new Gauge({
  name: "vela_worker_processing_lag_seconds",
  help: "Lag in seconds between job submission and processing pickup",
  labelNames: ["service"] as const,
  registers: [registry],
});
assertMetricName("vela_worker_processing_lag_seconds");

export const domainMetrics = {
  walletCreated,
  walletPasskeyAuth,
  passkeyAuth: walletPasskeyAuth,
  walletTxSigned,
  txSigned: walletTxSigned,
  policyDeployed,
  policyPoisonMessages,
  workerVerification,
  verification: workerVerification,
  lifecycleCleanupCompleted,
  cleanupCompleted: lifecycleCleanupCompleted,
  rpcErrors,
  workerVerificationTurnaround,
  verificationTurnaround: workerVerificationTurnaround,
  workerQueueDepth,
  workerProcessingLagSeconds,
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
