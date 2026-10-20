export interface VerificationServiceRuntimeConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** undefined = no Postgres; in-memory repository with a loud warning (dev only). */
  databaseUrl: string | undefined;
  /** Maximum build execution timeout in milliseconds, validated at boot (#536). */
  buildTimeoutMs: number;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

export class VerificationConfigError extends Error {
  readonly configKey: string;

  constructor(configKey: string, reason: string) {
    super(`Invalid verification-service config "${configKey}": ${reason}`);
    this.name = "VerificationConfigError";
    this.configKey = configKey;
  }
}

/**
 * Validates the `BUILD_TIMEOUT_MS` (`buildTimeoutMs`) configuration value at boot
 * rather than deferring validation to the first build job execution (#536).
 *
 * Rejects missing (`undefined` / empty), non-numeric, zero, negative, or non-finite values.
 */
export function validateBuildTimeoutConfig(
  raw: string | number | undefined,
  configKey = "BUILD_TIMEOUT_MS",
): number {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    throw new VerificationConfigError(
      configKey,
      `missing required build-timeout configuration (${configKey} / buildTimeoutMs)`,
    );
  }

  const parsed =
    typeof raw === "number"
      ? raw
      : /^-?\d+(\.\d+)?$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new VerificationConfigError(
      configKey,
      `expected a positive integer in milliseconds, got ${JSON.stringify(raw)}`,
    );
  }

  if (parsed <= 0) {
    throw new VerificationConfigError(
      configKey,
      `build-timeout must be greater than 0 ms, got ${parsed}`,
    );
  }

  return parsed;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VerificationServiceRuntimeConfig {
  const rawTimeout = env.BUILD_TIMEOUT_MS ?? env.VERIFY_BUILD_TIMEOUT_MS;
  const timeoutKey =
    env.BUILD_TIMEOUT_MS !== undefined
      ? "BUILD_TIMEOUT_MS"
      : env.VERIFY_BUILD_TIMEOUT_MS !== undefined
        ? "VERIFY_BUILD_TIMEOUT_MS"
        : "BUILD_TIMEOUT_MS";

  const buildTimeoutMs = validateBuildTimeoutConfig(rawTimeout, timeoutKey);

  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    databaseUrl: env.DATABASE_URL || undefined,
    buildTimeoutMs,
  };
}

export const DEFAULTS = {
  rpcUrl: TESTNET_RPC,
  networkPassphrase: TESTNET_PASSPHRASE,
  buildTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
} as const;
