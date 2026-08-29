import { dockerBuildExecutor, stubBuildExecutor, type BuildExecutor } from "./executor";
import { resolveNetwork, type Network } from "@vellar/service-kit";

export interface WorkerRuntimeConfig {
  /** The explicit, cross-checked network (RA-10). Resolved from STELLAR_NETWORK
   * and verified coherent with the passphrase + RPC at config time — the worker
   * refuses to boot on an incoherent or missing network. Security decisions
   * (the M5 attestor guard) read THIS, never an inference from the passphrase. */
  network: Network;
  rpcUrl: string;
  /** Required: the worker shares verification-service's Postgres. Without it the
   * worker has no jobs to claim and exits with a loud error. */
  databaseUrl: string | undefined;
  /** Toolchain image for real builds. Unset ⇒ the deterministic stub executor
   * (CI / hosted demo). Set ⇒ the real Docker build path. */
  buildImage: string | undefined;
  pollIdleMs: number;
  /** Build sandbox caps (§8.4). Env-tunable; safe defaults in the executor. */
  buildTimeoutSeconds: number | undefined;
  buildMemory: string | undefined;
  buildCpus: string | undefined;
  buildPidsLimit: number | undefined;
  /** On-chain attestation mirror (design-provenance-gated-spending.md). BOTH
   * must be set to enable; otherwise the attestor is disabled with a loud log. */
  attestorSecretKey: string | undefined;
  attestationRegistryId: string | undefined;
  networkPassphrase: string;
  /** Attestation lifetime in ledgers (default ~7 days at 5s close time). */
  attestationTtlLedgers: number | undefined;
  /** Upgrade-sweep interval (default 10 min). */
  attestationSweepMs: number;
  /** Reaper (M7): a 'building' row older than this is reclaimed. MUST exceed the
   * max real build time (buildTimeoutSeconds) so a live build is never reaped.
   * Default 15 min = 1.5x the 10-min build timeout. */
  reapTimeoutMs: number;
  /** Reaper interval — how often to sweep for stranded rows. Default 5 min. */
  reapIntervalMs: number;
  /** Max claim attempts before a stranded job is parked in 'dead_letter'
   * (default 3: a transient crash gets 2 retries, a poisoned job parks). */
  maxBuildAttempts: number;
  // ── ETL cleanup (issue #345) ─────────────────────────────────────────────
  /** A terminal row (verified/failed/dead_letter) must be at least this many
   * days old (measured from updated_at) before it is eligible for cleanup.
   * Default 90 days. Env: CLEANUP_RETENTION_DAYS. */
  cleanupRetentionDays: number;
  /** Maximum rows processed per cleanup run. Keeps individual transactions
   * small and the job safe to interrupt+resume. Default 500.
   * Env: CLEANUP_BATCH_SIZE. */
  cleanupBatchSize: number;
  /** How often the cleanup job runs (ms). Default 86 400 000 = 24 h.
   * Env: CLEANUP_INTERVAL_MS. */
  cleanupIntervalMs: number;
  /** When true (default) eligible rows are copied to verification_records_archive
   * before being deleted (archive-then-delete). Set to false to hard-delete
   * with no archival. Env: CLEANUP_ARCHIVE_ENABLED (0 disables). */
  cleanupArchiveEnabled: boolean;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  const rpcUrl = env.STELLAR_RPC_URL || TESTNET_RPC;
  const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
  // RA-10: resolve the network EXPLICITLY (STELLAR_NETWORK, required) and refuse
  // to boot if it is missing or disagrees with the passphrase/RPC. This throws a
  // NetworkConfigError naming the disagreeing values; index.ts surfaces it and
  // exits. Note: the passphrase/RPC keep testnet defaults because they are
  // needed as signing/connection values — the SECURITY signal is STELLAR_NETWORK,
  // which has no default, so a missing network never resolves to the permissive
  // side.
  const network = resolveNetwork({
    network: env.STELLAR_NETWORK,
    passphrase: networkPassphrase,
    rpcUrl,
  });
  return {
    network,
    rpcUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    buildImage: env.VERIFY_BUILD_IMAGE || undefined,
    pollIdleMs: env.VERIFY_POLL_IDLE_MS ? Number(env.VERIFY_POLL_IDLE_MS) : 5000,
    buildTimeoutSeconds: env.VERIFY_BUILD_TIMEOUT_S
      ? Number(env.VERIFY_BUILD_TIMEOUT_S)
      : undefined,
    buildMemory: env.VERIFY_BUILD_MEMORY || undefined,
    buildCpus: env.VERIFY_BUILD_CPUS || undefined,
    buildPidsLimit: env.VERIFY_BUILD_PIDS_LIMIT ? Number(env.VERIFY_BUILD_PIDS_LIMIT) : undefined,
    attestorSecretKey: env.ATTESTOR_SECRET_KEY || undefined,
    attestationRegistryId: env.ATTESTATION_REGISTRY_ID || undefined,
    networkPassphrase,
    attestationTtlLedgers: env.ATTESTATION_TTL_LEDGERS
      ? Number(env.ATTESTATION_TTL_LEDGERS)
      : undefined,
    attestationSweepMs: env.ATTESTATION_SWEEP_MS ? Number(env.ATTESTATION_SWEEP_MS) : 600_000,
    reapTimeoutMs: env.VERIFY_REAP_TIMEOUT_MS ? Number(env.VERIFY_REAP_TIMEOUT_MS) : 900_000,
    reapIntervalMs: env.VERIFY_REAP_INTERVAL_MS ? Number(env.VERIFY_REAP_INTERVAL_MS) : 300_000,
    maxBuildAttempts: env.VERIFY_MAX_ATTEMPTS ? Number(env.VERIFY_MAX_ATTEMPTS) : 3,
    cleanupRetentionDays: env.CLEANUP_RETENTION_DAYS ? Number(env.CLEANUP_RETENTION_DAYS) : 90,
    cleanupBatchSize: env.CLEANUP_BATCH_SIZE ? Number(env.CLEANUP_BATCH_SIZE) : 500,
    cleanupIntervalMs: env.CLEANUP_INTERVAL_MS ? Number(env.CLEANUP_INTERVAL_MS) : 86_400_000,
    cleanupArchiveEnabled: env.CLEANUP_ARCHIVE_ENABLED !== "0",
  };
}

/**
 * Selects the build executor from config (the 1A seam): a real Docker-backed
 * builder when VERIFY_BUILD_IMAGE is set, otherwise the deterministic stub used
 * in CI / hosted. Choosing here (not in the loop) keeps the decision explicit
 * and logged at startup.
 */
export function executorFromConfig(config: WorkerRuntimeConfig): {
  executor: BuildExecutor;
  mode: "docker" | "stub";
} {
  if (config.buildImage) {
    return {
      executor: dockerBuildExecutor({
        image: config.buildImage,
        timeoutSeconds: config.buildTimeoutSeconds,
        memory: config.buildMemory,
        cpus: config.buildCpus,
        pidsLimit: config.buildPidsLimit,
      }),
      mode: "docker",
    };
  }
  return { executor: stubBuildExecutor(), mode: "stub" };
}
