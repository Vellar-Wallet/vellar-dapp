import {
  hostFromEnv,
  portFromEnv,
  resolvePersistencePolicy,
  startService,
  tryConnectDb,
} from "@vellar/service-kit";
import { configFromEnv } from "./config";
import { FacilitatorClient } from "./lib/facilitator";
import { startNonceSweeper } from "./nonce-sweeper";
import { buildServer, type MarketplaceServiceDeps } from "./server";
import type { DbHandle } from "./db/client";

const config = configFromEnv();

const deps: MarketplaceServiceDeps = {
  facilitator: new FacilitatorClient({
    baseUrl: config.facilitatorUrl,
    timeoutMs: config.facilitatorTimeoutMs,
  }),
  networkPassphrase: config.networkPassphrase,
  nonceTtlMs: config.nonceTtlMs,
};

let closeDb: (() => Promise<void>) | undefined;
let dbHandle: DbHandle | undefined;

if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgListingRepository, createPgNonceRepository } = await import("./db/pg-repository");
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    dbHandle = handle;
    deps.listings = createPgListingRepository(handle.db);
    deps.nonces = createPgNonceRepository(handle.db);
    closeDb = handle.close;
  }
}

// Fail closed in production BEFORE building the server (FIX 7): a marketplace
// holding seller registrations in memory would silently lose them on restart.
const policy = resolvePersistencePolicy({
  databaseUrl: config.databaseUrl,
  nodeEnv: process.env.NODE_ENV,
  connected: config.databaseUrl ? dbHandle !== undefined : undefined,
  allowInmemory: process.env.ALLOW_INMEMORY === "1",
});
if (policy.action === "fail") {
  console.error(`[marketplace-service] ${policy.reason}`);
  process.exit(1);
}
deps.isReady = dbHandle ? () => dbHandle!.ping() : () => policy.action === "allow-inmemory";

const app = buildServer(deps);

if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
} else {
  app.log.warn(
    "DATABASE_URL not set — using in-memory repositories; listings and nonces will NOT survive a restart. " +
      "(ALLOW_INMEMORY explicitly permits this; production without it refuses to boot.)",
  );
}

// Expired nonces are swept on boot and on an interval, in the background — a
// request must never pay for this (§5.2 cleanup job).
if (deps.nonces) {
  const stopSweeper = startNonceSweeper({
    nonces: deps.nonces,
    intervalMs: config.nonceCleanupIntervalMs,
    log: app.log,
  });
  app.addHook("onClose", async () => stopSweeper());
}

await startService(app, {
  port: portFromEnv("MARKETPLACE_PORT", 4006),
  // Downstream services bind loopback only; the gateway is the public surface.
  host: hostFromEnv("127.0.0.1"),
});
