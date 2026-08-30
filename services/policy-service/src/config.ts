export interface PolicyServiceRuntimeConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** undefined = deploy endpoint disabled (service still validates/generates). */
  sponsorSecretKey: string | undefined;
  /** undefined = no Postgres; in-memory repository with a loud warning (dev only). */
  databaseUrl: string | undefined;
  /** Per-HTTP-request timeout (ms) for every individual RPC call the deploy
   * path makes (getAccount, simulateTransaction, prepareTransaction,
   * sendTransaction) — passed straight to `rpc.Server`'s own `timeout`
   * option (#327). Distinct from `deployPollTimeoutMs` below, which bounds
   * the *polling loop* waiting for the submitted tx to land. */
  deployRpcTimeoutMs: number;
  /** Overall budget (ms) for the deployInstance polling loop that waits for
   * transaction confirmation after submission (#327). */
  deployPollTimeoutMs: number;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const DEFAULT_DEPLOY_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_DEPLOY_POLL_TIMEOUT_MS = 60_000;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyServiceRuntimeConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    sponsorSecretKey: env.SPONSOR_SECRET_KEY || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    deployRpcTimeoutMs: positiveIntFromEnv(
      env.DEPLOY_RPC_TIMEOUT_MS,
      DEFAULT_DEPLOY_RPC_TIMEOUT_MS,
    ),
    deployPollTimeoutMs: positiveIntFromEnv(
      env.DEPLOY_POLL_TIMEOUT_MS,
      DEFAULT_DEPLOY_POLL_TIMEOUT_MS,
    ),
  };
}

export const DEFAULTS = {
  rpcUrl: TESTNET_RPC,
  networkPassphrase: TESTNET_PASSPHRASE,
  deployRpcTimeoutMs: DEFAULT_DEPLOY_RPC_TIMEOUT_MS,
  deployPollTimeoutMs: DEFAULT_DEPLOY_POLL_TIMEOUT_MS,
} as const;
