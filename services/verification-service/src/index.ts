import { portFromEnv, startService, tryConnectDb } from "@vela/service-kit";
import { configFromEnv } from "./config";
import { buildServer, type VerificationServiceDeps } from "./server";

// @vela/verification-service — accepts contract verification submissions, stores
// VerificationRecords, and enqueues deterministic-rebuild jobs (idea.md §6.3,
// §11; technical-doc.md §5.5/§7.6). It never runs builds itself — worker-service
// does that in an isolated process (§8.4) and updates records via the shared
// Postgres. When DATABASE_URL is set, a submitted record is a queued job the
// worker polls; without it, records live in memory and are never built (a loud
// warning is logged) — the submit/read API still works for local dev.

const config = configFromEnv();
const deps: VerificationServiceDeps = {};

let closeDb: (() => Promise<void>) | undefined;
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
  }
}

const app = buildServer(deps);
if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
}
if (!config.databaseUrl) {
  app.log.warn(
    "DATABASE_URL not set — using an in-memory verification store; submissions will NOT be built or survive a restart.",
  );
}

await startService(app, { port: portFromEnv("VERIFICATION_SERVICE_PORT", 4004) });
