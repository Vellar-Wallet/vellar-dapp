export interface VerificationServiceRuntimeConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** undefined = no Postgres; in-memory repository with a loud warning (dev only). */
  databaseUrl: string | undefined;
  /** Required positive timeout for verification builds. */
  buildTimeoutSeconds: number;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function parseBuildTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.VERIFY_BUILD_TIMEOUT_S;
  if (raw === undefined || raw === "") {
    throw new Error("VERIFY_BUILD_TIMEOUT_S must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("VERIFY_BUILD_TIMEOUT_S must be a positive integer");
  }
  return value;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VerificationServiceRuntimeConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    databaseUrl: env.DATABASE_URL || undefined,
    buildTimeoutSeconds: parseBuildTimeoutSeconds(env),
  };
}

export const DEFAULTS = {
  rpcUrl: TESTNET_RPC,
  networkPassphrase: TESTNET_PASSPHRASE,
} as const;
