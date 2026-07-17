import { portFromEnv, startService, tryConnectDb } from "@vela/service-kit";
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
if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgPolicyRepository } = await import("./db/pg-repository");
  // Degrade to in-memory (with an actionable warning) if Postgres is
  // unreachable, rather than crashing the service with a raw ECONNREFUSED.
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    deps.policies = createPgPolicyRepository(handle.db);
    closeDb = handle.close;
  }
}

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
    "DATABASE_URL not set — using an in-memory policy store; policies will NOT survive a restart.",
  );
}

await startService(app, { port: portFromEnv("POLICY_SERVICE_PORT", 4003) });
