import { deriveContractAddress } from "passkey-kit";
import { hash, Keypair } from "@stellar/stellar-sdk";

// Server-side keyId -> contractId derivation gate (security-audit.md V1).
//
// The smart-account address is a deterministic, secret-free function of the
// passkey credential id under passkey-kit's pinned factory scheme:
//   salt      = sha256(keyId)
//   deployer  = Keypair.fromRawEd25519Seed(sha256("kalepail"))   // public, no secret
//   contractId = deriveContractAddress(keyIdBuffer, deployerPubKey, passphrase)
// (wasm hash is NOT an input to the address.) The web client uses this default
// deployer with no deploySource (apps/web/lib/connector-factory.ts:57-61), and
// resolves keyId -> Buffer via base64url.toBuffer (passkey-kit kit.js:152).
//
// Gating /wallet/create on this closes create as a third funding path and turns
// the "client is contract-authoritative" property the keyId refutation rests on
// into an ENFORCED invariant: a caller cannot map their keyId to a contractId
// that isn't derive(keyId).

// The canonical passkey-kit deployer seed (passkey-kit dist/constants.js:56).
// Pinned here so a drift in the client's deployer fails this gate loudly rather
// than silently accepting a mismatched mapping.
const DEFAULT_DEPLOYER_SEED = "kalepail";

export interface DerivationConfig {
  /** Deployer G-address. Defaults to the canonical passkey-kit "kalepail"
   * deployer public key. Override only if the client uses a custom deploySource. */
  deployerPublicKey?: string;
  /** Network passphrase — from server config, never the request body (V5). */
  networkPassphrase: string;
}

/** The canonical passkey-kit deployer public key (no secret needed to compute). */
export function defaultDeployerPublicKey(): string {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(DEFAULT_DEPLOYER_SEED))).publicKey();
}

/** Derive the smart-account contract address for a base64url passkey credential id. */
export function deriveWalletContractId(keyIdBase64: string, config: DerivationConfig): string {
  const deployerPublicKey = config.deployerPublicKey ?? defaultDeployerPublicKey();
  // Byte-identical to passkey-kit's base64url.toBuffer(keyId) (kit.js:152).
  const keyIdBuffer = Buffer.from(keyIdBase64, "base64url");
  return deriveContractAddress(keyIdBuffer, deployerPublicKey, config.networkPassphrase);
}

export class DerivationMismatchError extends Error {
  readonly code = "contract_id_mismatch";
  constructor(claimed: string, expected: string) {
    super(
      `contractId ${claimed} does not match the address derived from keyId (${expected}); ` +
        `the wallet mapping must equal derive(keyId).`,
    );
    this.name = "DerivationMismatchError";
  }
}

/** Throws DerivationMismatchError unless the claimed contractId equals the
 * address derived from the keyId under the pinned scheme. */
export function assertDerivedContractId(
  keyIdBase64: string,
  claimedContractId: string,
  config: DerivationConfig,
): void {
  const expected = deriveWalletContractId(keyIdBase64, config);
  if (expected !== claimedContractId) {
    throw new DerivationMismatchError(claimedContractId, expected);
  }
}
