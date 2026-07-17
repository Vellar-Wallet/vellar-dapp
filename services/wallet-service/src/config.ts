export interface RelayerConfig {
  rpcUrl: string;
  networkPassphrase: string;
  baseUrl: string;
  apiKey: string;
}

export interface WalletServiceConfig {
  /** undefined = relayer not configured; the service still runs but submissions fail loudly. */
  relayer: RelayerConfig | undefined;
  /** Testnet fee-sponsor secret for direct-RPC submission of address-auth
   * Soroban txs (relayer can't parse P27 V2 credentials yet). */
  sponsorSecretKey: string | undefined;
  /** undefined = no Postgres; in-memory repositories with a loud warning (dev only). */
  databaseUrl: string | undefined;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WalletServiceConfig {
  const baseUrl = env.RELAYER_BASE_URL;
  const apiKey = env.RELAYER_API_KEY;
  const databaseUrl = env.DATABASE_URL || undefined;
  const sponsorSecretKey = env.SPONSOR_SECRET_KEY || undefined;

  if (!baseUrl || !apiKey) return { relayer: undefined, sponsorSecretKey, databaseUrl };

  return {
    relayer: {
      rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
      networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
      baseUrl,
      apiKey,
    },
    sponsorSecretKey,
    databaseUrl,
  };
}

export const DEFAULTS = {
  rpcUrl: TESTNET_RPC,
  networkPassphrase: TESTNET_PASSPHRASE,
} as const;
