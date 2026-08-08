import {
  budgetLimitsFromEnv,
  createUnavailableBudget,
  portFromEnv,
  resolvePersistencePolicy,
  startService,
  tryConnectDb,
  type SpendBudget,
} from "@vellar/service-kit";
import type { DbHandle } from "./db/client";
import { configFromEnv, DEFAULTS } from "./config";
import { createUnconfiguredSubmitter } from "./relayer";
import { buildServer, type WalletServiceDeps } from "./server";

// FIX 3 budget window + ceilings (confirmed). All env-overridable.
const BUDGET_WINDOW_MS = Number(process.env.BUDGET_WINDOW_MS) || 3_600_000; // 1h
const budgetLimits = {
  // sponsor submit path: 50 XLM / 500 calls.
  sponsor: budgetLimitsFromEnv(
    { maxXlmVar: "BUDGET_SPONSOR_MAX_XLM", maxCountVar: "BUDGET_SPONSOR_MAX_COUNT" },
    { defaultMaxXlm: 50, defaultMaxCount: 500 },
  ),
  // policy deploy line lives in policy-service; unused here but keeps one shape.
  deploy: budgetLimitsFromEnv(
    { maxXlmVar: "BUDGET_DEPLOY_MAX_XLM", maxCountVar: "BUDGET_DEPLOY_MAX_COUNT" },
    { defaultMaxXlm: 20, defaultMaxCount: 20 },
  ),
  // wallet create (relayer-funded): count-only, 30/window.
  create: budgetLimitsFromEnv(
    { maxCountVar: "BUDGET_CREATE_MAX_COUNT" },
    { defaultMaxCount: 30 },
  ),
};

const config = configFromEnv();

// Resolve persistence FIRST — the funding-path budget (FIX 3) needs a durable
// ledger, and the submitter needs that budget, so DB comes before both.
const deps: WalletServiceDeps = {
  // Scoping parses submitted XDR with the server's configured passphrase, never
  // the request body's network field (security-audit V5).
  networkPassphrase: config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
  submitter: createUnconfiguredSubmitter(), // replaced below
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

// FIX 7 (M6): fail closed in production BEFORE building the server.
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
deps.isReady = dbHandle ? () => dbHandle!.ping() : () => policy.action === "allow-inmemory";

// FIX 3 budget: Postgres-backed when durable, otherwise a fail-closed stub that
// refuses to fund (never sponsor/create unmetered). The network label is from
// server config, never a request body (V5).
const budgetNetwork = config.relayer?.networkPassphrase === DEFAULTS.networkPassphrase ? "testnet" : "mainnet";
let budget: SpendBudget;
if (dbHandle) {
  const { createPgSpendBudget } = await import("@vellar/service-kit");
  budget = createPgSpendBudget(dbHandle.db, { windowMs: BUDGET_WINDOW_MS, limits: budgetLimits });
} else {
  budget = createUnavailableBudget();
}
deps.budget = budget;

// Now build the submitter (sponsor path metered by the same budget).
let submitter = config.relayer
  ? (await import("./relayer-passkey")).createPasskeyServerSubmitter(config.relayer)
  : createUnconfiguredSubmitter();

if (config.sponsorSecretKey) {
  // Address-auth Soroban txs go direct-to-RPC via our sponsor (the relayer
  // can't parse their P27 V2 credentials); deploys etc. stay on the relayer.
  const { createHybridSubmitter, createSponsorSubmitter } = await import("./sponsor");
  submitter = createHybridSubmitter(
    createSponsorSubmitter({
      rpcUrl: config.relayer?.rpcUrl ?? DEFAULTS.rpcUrl,
      networkPassphrase: config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
      secretKey: config.sponsorSecretKey,
      // Per-call fee cap; env override for the rare legit heavy op (C1/H1).
      maxFeeStroops: process.env.SPONSOR_MAX_FEE_STROOPS || undefined,
      budget,
      budgetNetwork,
    }),
    submitter,
    config.relayer?.networkPassphrase ?? DEFAULTS.networkPassphrase,
  );
}
deps.submitter = submitter;

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
