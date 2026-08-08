import { portFromEnv, resolvePersistencePolicy, startService, tryConnectDb } from "@vellar/service-kit";
import type { DbHandle } from "./db/client";
import { configFromEnv } from "./config";
import { createPolicyDeployer } from "./deploy";
import { buildServer, type PolicyServiceDeps } from "./server";
import { SPENDING_POLICY_WASM_HASH } from "./templates";

const config = configFromEnv();
const deps: PolicyServiceDeps = {};

// The deploy endpoint needs the sponsor secret; without it the service still
// validates/generates policies but /deploy-instance returns 503.
deps.deployer = config.sponsorSecretKey
  ? createPolicyDeployer(
      {
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
        sponsorSecretKey: config.sponsorSecretKey,
      },
      SPENDING_POLICY_WASM_HASH,
    )
  : undefined;

// Postgres-backed policy store when configured; otherwise in-memory (dev only).
let closeDb: (() => Promise<void>) | undefined;
let dbHandle: DbHandle | undefined;
if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgPolicyRepository } = await import("./db/pg-repository");
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    dbHandle = handle;
    deps.policies = createPgPolicyRepository(handle.db);
    closeDb = handle.close;
  }
}

// FIX 7 (M6): fail closed in production before serving. The sponsor-funded
// deploy budget (FIX 3) lives here and needs durable state.
const policy = resolvePersistencePolicy({
  databaseUrl: config.databaseUrl,
  nodeEnv: process.env.NODE_ENV,
  connected: config.databaseUrl ? dbHandle !== undefined : undefined,
  allowInmemory: process.env.ALLOW_INMEMORY === "1",
});
if (policy.action === "fail") {
  console.error(`[policy-service] ${policy.reason}`);
  process.exit(1);
}
deps.isReady = dbHandle ? () => dbHandle!.ping() : () => policy.action === "allow-inmemory";

const app = buildServer(deps);
if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
}
if (!deps.deployer) {
  app.log.warn("SPONSOR_SECRET_KEY not set — policy instance deploys are disabled");
}
if (!config.databaseUrl) {
  app.log.warn(
    "DATABASE_URL not set — using an in-memory policy store; policies will NOT survive a restart. " +
      "(ALLOW_INMEMORY explicitly permits this; production without it refuses to boot.)",
  );
}

await startService(app, { port: portFromEnv("POLICY_SERVICE_PORT", 4003) });
