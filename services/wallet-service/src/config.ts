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

/** Validate relayer base URL has a proper scheme and is https by default.
 * Throws with a clear error message if validation fails. */
function validateRelayerUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(
      `RELAYER_BASE_URL="${baseUrl}" is not a valid URL. Provide a full URL with scheme, e.g., https://relayer.example.com`,
    );
  }

  // Require https for production security; warn but allow http for localhost dev.
  if (url.protocol === "http:") {
    if (
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      !url.hostname.startsWith("192.168.") &&
      !url.hostname.startsWith("10.") &&
      url.hostname !== "[::1]"
    ) {
      throw new Error(
        `RELAYER_BASE_URL="${baseUrl}" uses http:// scheme. Relayer URLs must use https:// for security. Use http:// only for localhost/internal IPs.`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(
      `RELAYER_BASE_URL="${baseUrl}" has scheme "${url.protocol}". Only https:// and http://localhost are supported.`,
    );
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WalletServiceConfig {
  const baseUrl = env.RELAYER_BASE_URL;
  const apiKey = env.RELAYER_API_KEY;
  const databaseUrl = env.DATABASE_URL || undefined;
  const sponsorSecretKey = env.SPONSOR_SECRET_KEY || undefined;

  if (!baseUrl || !apiKey) return { relayer: undefined, sponsorSecretKey, databaseUrl };

  // Validate the relayer URL at boot time
  validateRelayerUrl(baseUrl);

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
