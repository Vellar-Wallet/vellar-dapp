import { z } from "zod";

// Environment configuration for marketplace-service
// (new-build-technical-doc.md §10).

export const DEFAULTS = {
  facilitatorUrl: "https://vellar-facilitator.onrender.com",
  facilitatorTimeoutMs: 30_000,
  /** §5.2: the registration nonce is time-limited to five minutes. */
  nonceTtlMs: 5 * 60_000,
  /** Expired nonces are swept on boot and then on this interval. */
  nonceCleanupIntervalMs: 10 * 60_000,
} as const;

export interface MarketplaceConfig {
  databaseUrl?: string;
  facilitatorUrl: string;
  facilitatorTimeoutMs: number;
  nonceTtlMs: number;
  nonceCleanupIntervalMs: number;
  /** Passphrase used to parse submitted XDR for signature verification. Keyed
   * off SERVER config, never a request body (security-audit V5) — otherwise a
   * caller could present a mainnet-signed tx and have it validated as testnet. */
  networkPassphrase: string;
}

const positiveInt = (fallback: number) => (raw: string | undefined) => {
  const parsed = z.coerce.number().int().positive().safeParse(raw);
  return parsed.success ? parsed.data : fallback;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): MarketplaceConfig {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    facilitatorUrl: (env.FACILITATOR_URL || DEFAULTS.facilitatorUrl).replace(/\/+$/, ""),
    facilitatorTimeoutMs: positiveInt(DEFAULTS.facilitatorTimeoutMs)(env.FACILITATOR_TIMEOUT_MS),
    nonceTtlMs: positiveInt(DEFAULTS.nonceTtlMs)(env.MARKETPLACE_NONCE_TTL_MS),
    nonceCleanupIntervalMs: positiveInt(DEFAULTS.nonceCleanupIntervalMs)(
      env.MARKETPLACE_NONCE_CLEANUP_INTERVAL_MS,
    ),
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
  };
}
