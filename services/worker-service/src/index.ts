import pg from "pg";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import { domainMetrics, portFromEnv, registerHealth, registerMetrics } from "@vela/service-kit";
import { configFromEnv, executorFromConfig } from "./config";
import { createRpcArtifactResolver } from "./resolver";
import { createPgJobStore } from "./pg-job-store";
import { startWorkerLoop, type WorkerMetrics } from "./loop";

// @vela/worker-service — the deterministic build worker (technical-doc.md §8.4).
//
// Runs as its OWN isolated process, never combined with the wallet/policy
// services that hold sponsor keys (see the all-in-one note): it executes
// untrusted, submitter-provided build inputs, so it must be sandboxed away from
// any secret-bearing service. It shares only the verification_records table
// with verification-service, claiming "submitted" rows, rebuilding, comparing
// against the on-chain wasm hash, and writing the result.
//
// With no VERIFY_BUILD_IMAGE it runs the deterministic stub executor (CI /
// hosted demo, where real Rust builds can't run); with the image set it uses
// the real Docker build path.

const config = configFromEnv();

if (!config.databaseUrl) {
  // The worker has nothing to do without the shared store. Fail loudly rather
  // than idle-poll forever against nothing.
  console.error(
    "[worker-service] DATABASE_URL is not set — the build worker needs the shared verification store. Exiting.",
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);
const store = createPgJobStore(db);
const resolver = createRpcArtifactResolver({ rpcUrl: config.rpcUrl });
const { executor, mode } = executorFromConfig(config);

const log = {
  info: (msg: string) => console.log(`[worker-service] ${msg}`),
  error: (msg: string, err?: unknown) => console.error(`[worker-service] ${msg}`, err ?? ""),
};

if (mode === "stub") {
  log.info(
    "VERIFY_BUILD_IMAGE not set — using the deterministic STUB build executor. Real contract verification requires a build image (see docs/decisions.md).",
  );
} else {
  log.info(`using the Docker build executor (image=${config.buildImage}).`);
}

// Map loop outcomes onto the shared Prometheus metrics (idea.md §13).
const metrics: WorkerMetrics = {
  verificationResult(outcome, turnaroundSeconds) {
    domainMetrics.verification.inc({
      service: "worker-service",
      outcome: outcome === "verified" ? "success" : "failure",
      network: "unknown",
    });
    if (turnaroundSeconds !== undefined) {
      domainMetrics.verificationTurnaround.observe(
        { service: "worker-service", outcome },
        turnaroundSeconds,
      );
    }
  },
  workerFailure() {
    // §13 alerting: verification worker failures.
    domainMetrics.rpcErrors.inc({ service: "worker-service", upstream: "build" });
  },
};

// The worker is a background process, not an HTTP service — but it still exposes
// /health + /metrics on its own port so a scraper can watch it (§13 alerting on
// verification worker failures needs the counters to be reachable).
const metricsApp = Fastify({ logger: false });
registerHealth(metricsApp, "worker-service");
registerMetrics(metricsApp, "worker-service");
await metricsApp.listen({
  port: portFromEnv("WORKER_METRICS_PORT", 4005),
  host: "0.0.0.0",
});

const loop = startWorkerLoop({
  store,
  executor,
  resolver,
  idleDelayMs: config.pollIdleMs,
  log,
  metrics,
});
log.info(`build worker started (rpc=${config.rpcUrl}). Polling for submitted verifications.`);

const shutdown = async () => {
  log.info("shutting down…");
  loop.stop();
  await metricsApp.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
