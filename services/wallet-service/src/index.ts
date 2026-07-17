import { portFromEnv, startService, tryConnectDb } from "@vela/service-kit";
import { configFromEnv } from "./config";
import { createUnconfiguredSubmitter } from "./relayer";
import { buildServer, type WalletServiceDeps } from "./server";

const config = configFromEnv();

let submitter = config.relayer
  ? (await import("./relayer-passkey")).createPasskeyServerSubmitter(config.relayer)
  : createUnconfiguredSubmitter();

if (config.sponsorSecretKey) {
  // Address-auth Soroban txs go direct-to-RPC via our sponsor (the relayer
  // can't parse their P27 V2 credentials); deploys etc. stay on the relayer.
  const { createHybridSubmitter, createSponsorSubmitter } = await import("./sponsor");
  const { DEFAULTS } = await import("./config");
  submitter = createHybridSubmitter(
    createSponsorSubmitter({
      rpcUrl: config.relayer?.rpcUrl ?? DEFAULTS.rpcUrl,
      networkPassphrase: config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
      secretKey: config.sponsorSecretKey,
    }),
    submitter,
    config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
  );
}

const deps: WalletServiceDeps = { submitter };
let closeDb: (() => Promise<void>) | undefined;

if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgAuditLog, createPgSessionRepository, createPgWalletRepository } =
    await import("./db/pg-repository");
  // Degrade to in-memory (with an actionable warning) if Postgres is
  // unreachable, rather than crashing the service with a raw ECONNREFUSED.
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    // Fastify's app/logger doesn't exist yet (deps must be resolved first),
    // so this one startup-phase warning goes to the console.
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    deps.wallets = createPgWalletRepository(handle.db);
    deps.sessions = createPgSessionRepository(handle.db);
    deps.audit = createPgAuditLog(handle.db);
    closeDb = handle.close;
  }
}

const app = buildServer(deps);

if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
} else if (!config.databaseUrl) {
  app.log.warn(
    "DATABASE_URL not set — using in-memory repositories; wallet mappings will NOT survive a restart.",
  );
}

if (!config.relayer) {
  app.log.warn(
    "Relayer not configured (RELAYER_BASE_URL / RELAYER_API_KEY missing) — wallet creation and submission will return 502 until set.",
  );
}

await startService(app, { port: portFromEnv("WALLET_SERVICE_PORT", 4001) });
