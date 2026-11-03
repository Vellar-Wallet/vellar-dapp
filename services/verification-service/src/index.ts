import {
  hostFromEnv,
  portFromEnv,
  resolvePersistencePolicy,
  startService,
  tryConnectDb,
  enforceDeployEnvPolicy,
} from "@vellar/service-kit";
import { configFromEnv } from "./config";
import { buildServer, type VerificationServiceDeps } from "./server";

// Staging tier policy (catalogue 1.4): DEPLOY_ENV=staging refuses to boot unless it is
// testnet-pinned, on its own database, with every production escape hatch unset.
enforceDeployEnvPolicy("verification-service");

// @vellar/verification-service — accepts contract verification submissions, stores
// VerificationRecords, and enqueues deterministic-rebuild jobs (idea.md §6.3,
// §11; technical-doc.md §5.5/§7.6). It never runs builds itself — worker-service
// does that in an isolated process (§8.4) and updates records via the shared
// Postgres. When DATABASE_URL is set, a submitted record is a queued job the
// worker polls; without it, records live in memory and are never built.

const config = configFromEnv();
const deps: VerificationServiceDeps = {
  // Queue-depth cap (M7); env-overridable. Default 1000 active records.
  maxActiveQueue: process.env.VERIFY_QUEUE_MAX_ACTIVE
    ? Number(process.env.VERIFY_QUEUE_MAX_ACTIVE)
    : undefined,
};

let closeDb: (() => Promise<void>) | undefined;
let dbConnected = false;
if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgVerificationRepository } = await import("./db/pg-repository");
  const { createPgBuildJobQueue } = await import("./db/pg-queue");
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    deps.records = createPgVerificationRepository(handle.db);
    // The "queue" over Postgres is a no-op enqueue: the record row IS the job.
    // worker-service polls for status="submitted" rows and claims them.
    deps.queue = createPgBuildJobQueue();
    closeDb = handle.close;
    dbConnected = true;
  }
}

// RA-4: fail closed BEFORE serving. This service previously ALWAYS fell back to
// an in-memory store when DATABASE_URL was unset or unreachable, with no
// NODE_ENV backstop at all — the worst case of the M6/FIX-7 inertness class. Now
// the same fail-closed policy as wallet/policy-service applies: on a deploy
// target (NODE_ENV not development/test) a missing/unreachable DB refuses to
// boot rather than silently serving a store whose submissions are never built.
const policy = resolvePersistencePolicy({
  databaseUrl: config.databaseUrl,
  nodeEnv: process.env.NODE_ENV,
  connected: config.databaseUrl ? dbConnected : undefined,
  allowInmemory: process.env.ALLOW_INMEMORY === "1",
});
if (policy.action === "fail") {
  console.error(`[verification-service] ${policy.reason}`);
  process.exit(1);
}

const app = buildServer(deps);
if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
}
if (!dbConnected) {
  app.log.warn(
    "DATABASE_URL not set/unreachable — using an in-memory verification store; submissions will " +
      "NOT be built or survive a restart. (Explicitly permitted here via NODE_ENV=development/test " +
      "or ALLOW_INMEMORY=1; a production boot without a durable DB refuses to start.)",
  );
}

await startService(app, {
  port: portFromEnv("VERIFICATION_SERVICE_PORT", 4004),
  host: hostFromEnv("127.0.0.1"),
});
