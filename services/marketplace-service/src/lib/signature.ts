import {
  FeeBumpTransaction,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { SignatureError, ValidationError } from "./errors";

// Proof-of-address-control for seller registration and listing updates
// (new-build-technical-doc.md §5.2). The client signs a transaction that is
// NEVER submitted — it exists only so we can check a signature against a
// claimed G-address.
//
// Why a transaction and not a bare message: SEP-43 `signMessage` is not
// implemented consistently across the wallets we support (Albedo's is
// explicitly non-SEP-43, LOBSTR's signAuthEntry takes no argument), but every
// one of them signs transactions. A ManageData op carrying the nonce is the
// portable option.

/** The ManageData key the registration transaction must carry (§5.2). */
export const REGISTRATION_DATA_KEY = "vellar-register";

export interface VerifiedSignature {
  /** The G-address whose signature was verified. */
  address: string;
  /** The ManageData value, decoded as UTF-8 (the nonce for registration). */
  dataValue?: string;
}

/** True for a well-formed ed25519 public key (G...). Rejects contract (C) and
 * muxed (M) addresses: only a classic keypair can sign these transactions. */
export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

function parseTransaction(signedXdr: string, networkPassphrase: string): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new ValidationError("signedXdr is not a valid transaction envelope", "invalid_xdr");
  }
  // A fee-bump envelope has no operations of its own and its inner signatures
  // cover a different hash — refuse rather than silently inspect the wrong tx.
  if (parsed instanceof FeeBumpTransaction) {
    throw new ValidationError("Fee-bump transactions are not accepted here", "invalid_xdr");
  }
  return parsed;
}

/**
 * Confirms the transaction carries a valid signature from `address`.
 *
 * The transaction hash is computed with the SERVER's configured passphrase
 * (security-audit V5): a signature is only valid for the network it was made
 * on, so a mainnet-signed proof cannot be replayed at a testnet service.
 *
 * Checks every signature rather than only the first — a wallet may add its
 * signature after others, and hint collisions are possible (a hint is only 4
 * bytes), so the hint is used as a filter, never as the proof.
 */
function assertSignedBy(tx: Transaction, address: string): void {
  if (!isValidStellarAddress(address)) {
    throw new ValidationError("walletAddress must be a valid Stellar G-address", "invalid_address");
  }
  const keypair = Keypair.fromPublicKey(address);
  const hash = tx.hash();
  const signed = tx.signatures.some((sig) => {
    try {
      return keypair.verify(hash, sig.signature());
    } catch {
      return false;
    }
  });
  if (!signed) {
    throw new SignatureError(`No valid signature from ${address} on the supplied transaction`);
  }
}

/**
 * Lighter check used by payment and listing-update flows: prove the caller
 * controls `address`, without consuming a registration nonce.
 *
 * NOTE (deliberate limitation, documented rather than hidden): with no nonce,
 * this proves control of the key but NOT freshness — a previously seen signed
 * envelope replays successfully until its own timebounds expire. It is
 * therefore used only for operations that are idempotent or separately
 * authorized, never to establish ownership of a listing for the first time.
 * Registration — the one flow that grants ownership — uses the full
 * nonce-consuming path below.
 */
export function verifySignedBy(
  signedXdr: string,
  address: string,
  networkPassphrase: string,
): VerifiedSignature {
  const tx = parseTransaction(signedXdr, networkPassphrase);
  assertSignedBy(tx, address);
  return { address, dataValue: readRegistrationValue(tx) };
}

/** Extracts the ManageData value when the tx is a registration-shaped one. */
function readRegistrationValue(tx: Transaction): string | undefined {
  const op = tx.operations[0];
  if (tx.operations.length === 1 && op?.type === "manageData" && op.name === REGISTRATION_DATA_KEY) {
    return op.value ? Buffer.from(op.value).toString("utf8") : undefined;
  }
  return undefined;
}

/**
 * Full registration check (§5.2 steps a–e). Structural validation plus
 * signature; the caller then consumes the returned nonce (step f) against the
 * nonce store, which is what makes the proof single-use.
 */
export function verifyRegistrationSignature(
  signedXdr: string,
  address: string,
  networkPassphrase: string,
): { address: string; nonce: string } {
  const tx = parseTransaction(signedXdr, networkPassphrase);

  // (b) exactly one operation — extra operations could carry side effects if
  // this envelope were ever submitted, and they muddy what the signature covers.
  if (tx.operations.length !== 1) {
    throw new ValidationError(
      "Registration transaction must contain exactly one operation",
      "invalid_registration_tx",
    );
  }

  // (c) it must be ManageData("vellar-register", <nonce>).
  const op = tx.operations[0];
  if (!op || op.type !== "manageData" || op.name !== REGISTRATION_DATA_KEY) {
    throw new ValidationError(
      `Registration operation must be ManageData("${REGISTRATION_DATA_KEY}", nonce)`,
      "invalid_registration_tx",
    );
  }
  if (!op.value || op.value.length === 0) {
    throw new ValidationError("Registration nonce value is missing", "invalid_registration_tx");
  }
  const nonce = Buffer.from(op.value).toString("utf8");

  // (e) signature from the claimed address. Checked AFTER the structural
  // checks so a malformed tx never reaches the crypto path.
  assertSignedBy(tx, address);

  return { address, nonce };
}
