import { Address, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

// Route-level funding-path scoping (security-audit.md C1 + H1 + V2).
//
// createHybridSubmitter routes address-auth Soroban invokes to the sponsor and
// everything else to the relayer — BOTH spend Vellar-held funds (sponsor key /
// relayer quota). Scoping only the sponsor branch (needsSponsorRebuild) just
// relocates the abuse to the relayer, so this guard runs at the ROUTE, before
// the submitter picks a branch: the tx is accepted only when every
// address-credential auth subject is a smart-account wallet the server knows.
//
// A tx with NO address-credential subject cannot be attributed to a known
// wallet, so it is rejected here too — /wallet/submit is for post-deploy wallet
// operations (which always carry address credentials); deploys use the separate
// /wallet/create path (which is scoped by keyId->contract derivation instead).

export class ScopeError extends Error {
  readonly code: string;

  constructor(message: string, code = "unscoped_transaction") {
    super(message);
    this.name = "ScopeError";
    this.code = code;
  }
}

/**
 * The `SorobanAddressCredentials` for an auth entry, across ALL address-bound
 * credential variants — or undefined for source-account credentials.
 *
 * The production signer (`passkey-kit@0.14.0`) never emits V1: it upgrades every
 * signed entry IN PLACE to `sorobanCredentialsAddressV2` (auth-payload.js:65-67)
 * and refuses to sign a non-address-bound payload. Matching only the V1 string
 * (the RA-1 defect) therefore returned [] for real traffic — a fail-closed break
 * — and skipped attacker V2 legs in a mixed tx. All three address-bound arms
 * (`address` V1, `addressV2`, `addressWithDelegates`) wrap the same
 * `SorobanAddressCredentials`, so the subject address is read uniformly.
 */
export function addressCredentials(
  creds: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | undefined {
  switch (creds.switch().name) {
    case "sorobanCredentialsAddress":
      return creds.address();
    case "sorobanCredentialsAddressV2":
      return creds.addressV2();
    case "sorobanCredentialsAddressWithDelegates":
      return creds.addressWithDelegates().addressCredentials();
    default:
      return undefined; // sorobanCredentialsSourceAccount — no address subject
  }
}

/** Every address-credential auth subject (smart-account C-address) in a single
 * signed transaction. Returns [] for an unparseable xdr or a tx with no
 * address-credential auth entries. */
export function extractAddressAuthSubjects(signedXdr: string, networkPassphrase: string): string[] {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return [];
  }
  if (!("operations" in tx)) return [];

  const subjects: string[] = [];
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction" || !op.auth) continue;
    for (const entry of op.auth) {
      const addrCreds = addressCredentials(entry.credentials());
      if (!addrCreds) continue; // source-account: no subject to attribute
      subjects.push(Address.fromScAddress(addrCreds.address()).toString());
    }
  }
  return subjects;
}

/** Throws ScopeError unless the tx carries at least one address-credential
 * subject AND every such subject is a wallet the server recognizes. */
export async function assertScopedToKnownWallets(
  signedXdr: string,
  networkPassphrase: string,
  isKnownWallet: (contractId: string) => Promise<boolean>,
): Promise<void> {
  const subjects = extractAddressAuthSubjects(signedXdr, networkPassphrase);
  if (subjects.length === 0) {
    throw new ScopeError(
      "Transaction has no address-credential auth subject; cannot attribute it to a known wallet.",
      "no_wallet_subject",
    );
  }
  for (const subject of subjects) {
    if (!(await isKnownWallet(subject))) {
      throw new ScopeError(
        `Transaction authorizes a contract the server does not recognize as a wallet (${subject}).`,
        "unknown_wallet_subject",
      );
    }
  }
}
