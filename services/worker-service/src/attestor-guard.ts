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

/** Throws when a single-key attestor would be wired against mainnet.
 * In production (`NODE_ENV === "production"`), the escape hatch is permanently hard-gated:
 * single-key attestor is never permitted on mainnet under any circumstance.
 * Outside production, it requires the explicit `allowSingleKey` override.
 * No-op on testnet. */
export function assertAttestorSafeForNetwork(opts: {
  network: Network;
  allowSingleKey: boolean;
  nodeEnv?: string;
}): void {
  if (opts.network === "mainnet") {
    const resolvedNodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
    const isProd = resolvedNodeEnv === "production";
    if (isProd) {
      throw new SingleKeyAttestorOnMainnetError(
        "Refusing single-key attestor on mainnet: escape hatch is hard-gated in production.",
      );
    }
    // NODE_ENV may be unset in local/CI setups. Treat unset as non-production for this
    // guard, but NEVER silently allow: mainnet single-key still requires explicit opt-in.
    // This is the safer default because a missing env var must not weaken mainnet posture.
    if (!opts.allowSingleKey) {
      throw new SingleKeyAttestorOnMainnetError();
    }
  }
}
