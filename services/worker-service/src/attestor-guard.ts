// M5 hard guard (security-audit.md): the attestation registry is a single-key
// oracle — one ATTESTOR_SECRET_KEY compromise forges provenance for any
// contract. The real fix (a multisig / Soroban smart-account attestor) is
// DEFERRED (docs/decisions.md), but the deferral must not silently become a
// mainnet exposure. So: refuse to wire the single-key attestor against a
// MAINNET registry unless an operator explicitly accepts the risk.
//
// RA-10: the network is now taken from the EXPLICIT, cross-checked
// `resolveNetwork` (network-config.ts) — NOT inferred here from a passphrase
// that has a testnet default. This guard no longer classifies the network
// itself; it just refuses single-key-on-mainnet. See the attestor design note
// in docs/security-audit.md (FIX 4) for the intended smart-account attestor.

import type { Network } from "@vellar/service-kit";

export class SingleKeyAttestorOnMainnetError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Refusing to run the single-key attestor against a MAINNET attestation registry (M5): " +
          "a single ATTESTOR_SECRET_KEY compromise forges provenance for any contract. Configure a " +
          "multisig / smart-account attestor first, or set ALLOW_SINGLE_KEY_ATTESTOR=1 to explicitly " +
          "accept the risk in non-production. See docs/security-audit.md (FIX 4).",
    );
    this.name = "SingleKeyAttestorOnMainnetError";
  }
}

export interface AttestorGuardOptions {
  network: Network;
  /** Whether the operator set the single-key escape hatch (`ALLOW_SINGLE_KEY_ATTESTOR`). */
  allowSingleKey?: boolean;
  /** Optional raw env object to read `ALLOW_SINGLE_KEY_ATTESTOR` and `NODE_ENV` from. */
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
  /** Optional warning sink invoked when a mainnet-only flag is redundantly set on testnet. */
  warn?: (message: string) => void;
}

export interface AttestorGuardResult {
  allowed: true;
  network: Network;
  mode: "testnet_default" | "testnet_redundant_override" | "mainnet_override";
  warning?: string;
}

/**
 * Parses `ALLOW_SINGLE_KEY_ATTESTOR` environment values (`"1"` or `"true"`, case-insensitive).
 */
export function parseAllowSingleKeyAttestor(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Throws when a single-key attestor would be wired against mainnet without an
 * allowed non-production override.
 *
 * Behavior by network:
 * - `mainnet`:
 *   - In production (`NODE_ENV === "production"`), the escape hatch is permanently
 *     hard-gated: single-key attestor is never permitted on mainnet under any circumstance.
 *   - Outside production, requires the explicit `allowSingleKey` (`ALLOW_SINGLE_KEY_ATTESTOR`)
 *     override; otherwise throws `SingleKeyAttestorOnMainnetError`.
 * - `testnet`:
 *   - Single-key attestor is always permitted on testnet.
 *   - Setting `ALLOW_SINGLE_KEY_ATTESTOR` on testnet is a documented no-op that emits
 *     an operator warning (`mode: "testnet_redundant_override"`) so misconfigured
 *     environments are visible without blocking testnet startup.
 */
export function assertAttestorSafeForNetwork(opts: AttestorGuardOptions): AttestorGuardResult {
  const allowSingleKey =
    opts.allowSingleKey ?? parseAllowSingleKeyAttestor(opts.env?.ALLOW_SINGLE_KEY_ATTESTOR);
  const effectiveNodeEnv = opts.nodeEnv ?? opts.env?.NODE_ENV ?? process.env.NODE_ENV;

  if (opts.network === "mainnet") {
    const isProd = effectiveNodeEnv === "production";
    if (isProd) {
      throw new SingleKeyAttestorOnMainnetError(
        "Refusing single-key attestor on mainnet: escape hatch is hard-gated in production.",
      );
    }
    if (!allowSingleKey) {
      throw new SingleKeyAttestorOnMainnetError();
    }
    return {
      allowed: true,
      network: "mainnet",
      mode: "mainnet_override",
    };
  }

  if (allowSingleKey) {
    const warning =
      "ALLOW_SINGLE_KEY_ATTESTOR is set while STELLAR_NETWORK=testnet; single-key attestation is already permitted on testnet so this override is a no-op.";
    opts.warn?.(warning);
    return {
      allowed: true,
      network: "testnet",
      mode: "testnet_redundant_override",
      warning,
    };
  }

  return {
    allowed: true,
    network: "testnet",
    mode: "testnet_default",
  };
}
