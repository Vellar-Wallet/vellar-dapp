/**
 * Cleanup worker service (Issue #293).
 *
 * Standalone worker process that polls the cleanup_jobs queue and builds
 * unsigned cleanup transactions in per-account FIFO order.
 *
 * This is a separate process (not co-located with the HTTP API) to allow
 * horizontal scaling: multiple workers can run independently, each claiming
 * batches of jobs ordered by (accountId, createdAt), ensuring per-account
 * sequencing without global locks.
 */

import {
  hostFromEnv,
  portFromEnv,
  registerHealth,
  registerMetrics,
  tryConnectDb,
  resolvePersistencePolicy,
} from "@vellar/service-kit";
import Fastify from "fastify";
import { createHorizonAccountReader } from "../horizon";
import { createPgCleanupJobStore } from "../db/pg-job-store";
import { connectDb } from "../db/client";
import { startWorkerLoop } from "./loop";
import { registerCleanupMetrics } from "./metrics";

const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const databaseUrl = process.env.DATABASE_URL;

// Health check and metrics server
const app = Fastify({ logger: true });
registerHealth(app, "lifecycle-worker");
const metricsRegistry = registerMetrics(app, "lifecycle-worker");

// Register cleanup-specific metrics
const cleanupMetrics = registerCleanupMetrics(metricsRegistry);

let closeDb: (() => Promise<void>) | undefined;
let dbConnected = false;

if (!databaseUrl) {
  app.log.error("DATABASE_URL not set — cleanup worker requires Postgres");
  process.exit(1);
}

// Connect to database
const handle = await tryConnectDb(() => connectDb(databaseUrl), {
  databaseUrl,
  log: {
    warn: (message) => app.log.warn(message),
  },
});

if (!handle) {
  app.log.error("Failed to connect to database");
  process.exit(1);
}

dbConnected = true;
closeDb = handle.close;

const jobStore = createPgCleanupJobStore(handle.db);
const horizonReader = createHorizonAccountReader(horizonUrl);

// Start the worker loop
const workerLoop = startWorkerLoop({
  store: jobStore,
  reader: horizonReader,
  batchSize: 5,
  idleDelayMs: 5000,
  busyDelayMs: 250,
  log: {
    info: (msg) => app.log.info(msg),
    error: (msg, err) => app.log.error({ err }, msg),
  },
  metrics: {
    cleanupJobsClaimed: (count) => {
      cleanupMetrics.cleanupJobsClaimed.inc(count);
    },
    cleanupJobsCompleted: (count) => {
      cleanupMetrics.cleanupJobsCompleted.inc(count);
    },
    cleanupJobsFailed: (count) => {
      cleanupMetrics.cleanupJobsFailed.inc(count);
    },
    cleanupOutOfOrderDetected: () => {
      cleanupMetrics.cleanupOutOfOrder.inc();
    },
  },
});

if (closeDb) {
  app.addHook("onClose", async () => {
    workerLoop.stop();
    await closeDb?.();
  });
}

const port = portFromEnv("LIFECYCLE_WORKER_PORT", 4006);
const host = hostFromEnv("127.0.0.1");

await app.listen({ port, host });
app.log.info(`Cleanup worker listening on ${host}:${port}`);
