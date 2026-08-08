// M5 hard guard (security-audit.md): the attestation registry is a single-key
// oracle — one ATTESTOR_SECRET_KEY compromise forges provenance for any
// contract. The real fix (a multisig / Soroban smart-account attestor) is
// DEFERRED (docs/decisions.md), but the deferral must not silently become a
// mainnet exposure. So: refuse to wire the single-key attestor against a
// MAINNET registry unless an operator explicitly accepts the risk.
//
// See the attestor design note in docs/security-audit.md (FIX 4) for the
// intended smart-account attestor.

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export type AttestorNetwork = "testnet" | "mainnet";

export function attestorNetwork(networkPassphrase: string): AttestorNetwork {
  return networkPassphrase === MAINNET_PASSPHRASE ? "mainnet" : "testnet";
}

export class SingleKeyAttestorOnMainnetError extends Error {
  constructor() {
    super(
      "Refusing to run the single-key attestor against a MAINNET attestation registry (M5): " +
        "a single ATTESTOR_SECRET_KEY compromise forges provenance for any contract. Configure a " +
        "multisig / smart-account attestor first, or set ALLOW_SINGLE_KEY_ATTESTOR=1 to explicitly " +
        "accept the risk. See docs/security-audit.md (FIX 4).",
    );
    this.name = "SingleKeyAttestorOnMainnetError";
  }
}

/** Throws when a single-key attestor would be wired against a mainnet registry
 * without the explicit override. No-op on testnet. */
export function assertAttestorSafeForNetwork(opts: {
  networkPassphrase: string;
  allowSingleKey: boolean;
}): void {
  if (attestorNetwork(opts.networkPassphrase) === "mainnet" && !opts.allowSingleKey) {
    throw new SingleKeyAttestorOnMainnetError();
  }
}
