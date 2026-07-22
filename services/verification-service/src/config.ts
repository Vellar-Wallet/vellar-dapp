export interface VerificationServiceRuntimeConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** undefined = no Postgres; in-memory repository with a loud warning (dev only). */
  databaseUrl: string | undefined;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VerificationServiceRuntimeConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    databaseUrl: env.DATABASE_URL || undefined,
  };
}

export const DEFAULTS = {
  rpcUrl: TESTNET_RPC,
  networkPassphrase: TESTNET_PASSPHRASE,
} as const;
