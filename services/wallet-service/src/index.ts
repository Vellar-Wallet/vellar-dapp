import { portFromEnv, resolvePersistencePolicy, startService, tryConnectDb } from "@vellar/service-kit";
import type { DbHandle } from "./db/client";
import { configFromEnv, DEFAULTS } from "./config";
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
      // Per-call fee cap; env override for the rare legit heavy op (C1/H1).
      maxFeeStroops: process.env.SPONSOR_MAX_FEE_STROOPS || undefined,
    }),
    submitter,
    config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
  );
}

const deps: WalletServiceDeps = {
  submitter,
  // Scoping parses submitted XDR with the server's configured passphrase, never
  // the request body's network field (security-audit V5).
  networkPassphrase: config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
};
let closeDb: (() => Promise<void>) | undefined;
let dbHandle: DbHandle | undefined;

if (config.databaseUrl) {
  const databaseUrl = config.databaseUrl;
  const { connectDb } = await import("./db/client");
  const { createPgAuditLog, createPgSessionRepository, createPgWalletRepository } =
    await import("./db/pg-repository");
  const handle = await tryConnectDb(() => connectDb(databaseUrl), {
    databaseUrl,
    log: { warn: (message) => console.warn(message) },
  });
  if (handle) {
    dbHandle = handle;
    deps.wallets = createPgWalletRepository(handle.db);
    deps.sessions = createPgSessionRepository(handle.db);
    deps.audit = createPgAuditLog(handle.db);
    closeDb = handle.close;
  }
}

// FIX 7 (M6): decide fail-closed vs in-memory BEFORE building the server. The
// scoping (FIX 1) and budget (FIX 3) guards depend on durable state, so a
// production instance must never silently serve on volatile memory.
const policy = resolvePersistencePolicy({
  databaseUrl: config.databaseUrl,
  nodeEnv: process.env.NODE_ENV,
  connected: config.databaseUrl ? dbHandle !== undefined : undefined,
  allowInmemory: process.env.ALLOW_INMEMORY === "1",
});
if (policy.action === "fail") {
  console.error(`[wallet-service] ${policy.reason}`);
  process.exit(1);
}

// DB-aware readiness: reports not-ready if we're on in-memory OR Postgres drops
// mid-run (dbHandle.ping) — so /health returns 503 and the orchestrator stops
// routing rather than serving on a store that can't scope/budget.
deps.isReady = dbHandle ? () => dbHandle!.ping() : () => policy.action === "allow-inmemory";

const app = buildServer(deps);

if (closeDb) {
  app.addHook("onClose", async () => closeDb?.());
  app.log.info("Postgres connected, migrations applied");
} else {
  app.log.warn(
    "DATABASE_URL not set — using in-memory repositories; wallet mappings will NOT survive a restart. " +
      "(ALLOW_INMEMORY explicitly permits this; production without it refuses to boot.)",
  );
}

if (!config.relayer) {
  app.log.warn(
    "Relayer not configured (RELAYER_BASE_URL / RELAYER_API_KEY missing) — wallet creation and submission will return 502 until set.",
  );
}

await startService(app, { port: portFromEnv("WALLET_SERVICE_PORT", 4001) });
