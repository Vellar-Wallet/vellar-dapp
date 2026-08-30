import pg from "pg";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import { domainMetrics, portFromEnv, registerHealth, registerMetrics } from "@vellar/service-kit";
import { configFromEnv, executorFromConfig } from "./config";
import { createRpcArtifactResolver } from "./resolver";
import { createPgJobStore } from "./pg-job-store";
import { startWorkerLoop, type WorkerMetrics } from "./loop";
import { createVerificationGroup } from "./consumer-groups";
import { createAttestor, type Attestor } from "./attestor";
import { assertAttestorSafeForNetwork } from "./attestor-guard";
import { createRegistrySubmitter } from "./registry-submitter";
import { jitteredDelayMs } from "./jitter";
import { safeLog, createSafeLogger } from "./config/secretsRedactor";
import { validateSecrets } from "./config/validateSecrets";

// @vellar/worker-service — the deterministic build worker (technical-doc.md §8.4).
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

// Validate secrets at startup (names only, never values)
try {
  validateSecrets();
} catch (err) {
  safeLog("error", "[worker-service] Secret validation failed", err);
  process.exit(1);
}

if (!config.databaseUrl) {
  // The worker has nothing to do without the shared store. Fail loudly rather
  // than idle-poll forever against nothing.
  safeLog(
    "error",
    "[worker-service] DATABASE_URL is not set — the build worker needs the shared verification store. Exiting."
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);
const store = createPgJobStore(db);
const resolver = createRpcArtifactResolver({ rpcUrl: config.rpcUrl, timeoutMs: config.rpcTimeoutMs });
const { executor, mode } = executorFromConfig(config);

const log = createSafeLogger();

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
    domainMetrics.workerVerification.inc({
      service: "worker-service",
      outcome: outcome === "verified" ? "success" : "failure",
      network: "unknown",
    });
    if (turnaroundSeconds !== undefined) {
      domainMetrics.workerVerificationTurnaround.observe(
        { service: "worker-service", outcome },
        turnaroundSeconds,
      );
    }
  },
  workerFailure() {
    // §13 alerting: verification worker failures.
    domainMetrics.rpcErrors.inc({ service: "worker-service", upstream: "build" });
  },
  queueDepth(depth) {
    domainMetrics.workerQueueDepth.set({ service: "worker-service" }, depth);
  },
  processingLag(lagSeconds) {
    domainMetrics.workerProcessingLagSeconds.set({ service: "worker-service" }, lagSeconds);
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

// On-chain attestation mirror (design-provenance-gated-spending.md): enabled
// only when both the attestor secret and the registry id are configured;
// otherwise loudly disabled — verification keeps working either way.
let attestor: Attestor | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
if (config.attestorSecretKey && config.attestationRegistryId) {
  // M5 hard guard: the attestor is a single hot key today; refuse to wire it
  // against a MAINNET registry until a multisig/smart-account attestor exists
  // (unless explicitly overridden). Fail closed.
  try {
    assertAttestorSafeForNetwork({
      network: config.network,
      allowSingleKey: process.env.ALLOW_SINGLE_KEY_ATTESTOR === "1",
    });
  } catch (err) {
    safeLog("error", `[worker-service] ${err instanceof Error ? err.message : String(err)}`, err);
    process.exit(1);
  }
  attestor = createAttestor({
    submitter: createRegistrySubmitter({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      registryContractId: config.attestationRegistryId,
      attestorSecretKey: config.attestorSecretKey,
    }),
    ttlLedgers: config.attestationTtlLedgers,
    log,
  });
  log.info(`attestor enabled (registry=${config.attestationRegistryId}).`);
  // Upgrade sweep: revoke attestations whose contract was upgraded or deleted.
  const runSweep = () => attestor!.runUpgradeSweep(store, resolver);
  sweepTimer = setInterval(runSweep, config.attestationSweepMs);
  void runSweep();
} else {
  log.info(
    "ATTESTOR_SECRET_KEY / ATTESTATION_REGISTRY_ID not set — on-chain attestation mirror DISABLED (verification unaffected).",
  );
}

const loop = startWorkerLoop({
  store,
  executor,
  resolver,
  concurrencyLimit: config.concurrencyLimit,
  idleDelayMs: config.pollIdleMs,
  log,
  metrics,
  attestor,
});
log.info(`build worker started (rpc=${config.rpcUrl}). Polling for submitted verifications.`);

// Consumer groups (issue #354): domain-specific consumer groups allow
// independent scaling and monitoring. Currently we run a single verification
// group, but this architecture enables future transaction processing groups
// or other domains to be added with their own stores and concurrency settings.
const verificationGroup = createVerificationGroup({
  store,
  executor,
  resolver,
  concurrency: config.workerConcurrency ?? 1,
  idleDelayMs: config.pollIdleMs,
  log,
});
log.info(
  `verification consumer group started (concurrency=${config.workerConcurrency ?? 1}, rpc=${config.rpcUrl}).`,
);

// Reaper (M7): periodically return crashed 'building' rows to the queue, or
// park them in dead_letter after too many attempts, so a mid-build crash can't
// strand a job forever.
//
// Jittered (issue #331): a fixed setInterval would tick every replica of this
// service at the same wall-clock moments (most obviously right after a
// rolling deploy, when every instance boots within the same few seconds),
// turning a routine reclaim sweep into a synchronized spike against Postgres.
// Rescheduling with setTimeout (rather than setInterval) lets each tick draw
// a fresh jittered delay instead of repeating one fixed period forever.
let reapTimer: ReturnType<typeof setTimeout> | undefined;
let reaperStopped = false;

const runReaper = async () => {
  try {
    const res = await store.reapStranded({
      timeoutMs: config.reapTimeoutMs,
      maxAttempts: config.maxBuildAttempts,
      baseBackoffDelayMs: config.backoffBaseDelayMs,
      maxBackoffDelayMs: config.maxBackoffDelayMs,
      // Track retry attempts for metrics
      onReclaimed: (attempt: number) => {
        domainMetrics.verificationRetry.inc({
          service: "worker-service",
          attempt: String(attempt),
        });
      },
      // Track dead-lettered jobs
      onDeadLettered: () => {
        domainMetrics.verificationDeadLetter.inc({
          service: "worker-service",
        });
      },
    });
    if (res.reclaimed || res.deadLettered) {
      log.info(`reaper: reclaimed ${res.reclaimed}, dead-lettered ${res.deadLettered}`);
    }
  } catch (err) {
    log.error("reaper sweep failed", err);
  } finally {
    if (!reaperStopped) {
      reapTimer = setTimeout(runReaper, jitteredDelayMs(config.reapIntervalMs, config.reapJitterMs));
    }
  }
};
void runReaper();

const shutdown = async () => {
  log.info("shutting down…");
  loop.stop();
  verificationGroup.stop();
  if (sweepTimer) clearInterval(sweepTimer);
  reaperStopped = true;
  clearTimeout(reapTimer);
  await metricsApp.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
