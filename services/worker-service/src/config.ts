import { dockerBuildExecutor, stubBuildExecutor, type BuildExecutor } from "./executor";

export interface WorkerRuntimeConfig {
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
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
    databaseUrl: env.DATABASE_URL || undefined,
    buildImage: env.VERIFY_BUILD_IMAGE || undefined,
    pollIdleMs: env.VERIFY_POLL_IDLE_MS ? Number(env.VERIFY_POLL_IDLE_MS) : 5000,
    buildTimeoutSeconds: env.VERIFY_BUILD_TIMEOUT_S
      ? Number(env.VERIFY_BUILD_TIMEOUT_S)
      : undefined,
    buildMemory: env.VERIFY_BUILD_MEMORY || undefined,
    buildCpus: env.VERIFY_BUILD_CPUS || undefined,
    buildPidsLimit: env.VERIFY_BUILD_PIDS_LIMIT ? Number(env.VERIFY_BUILD_PIDS_LIMIT) : undefined,
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
