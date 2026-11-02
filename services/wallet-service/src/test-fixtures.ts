import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// Shared signed-transaction fixtures for the funding-path tests (scope, replay,
// route). Entries are built the way passkey-kit@0.14 emits them (V2 address
// credentials) so tests read as "what the kit produces" (RA-9).

export const PASSPHRASE = "Test SDF Network ; September 2015";

// A valid Vellar-style smart-account C-address and an unrelated contract.
export const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const OTHER_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

/** Which auth-credential shape to build. The production signer
 * (passkey-kit@0.14.0) never emits V1 for a signed wallet op: it upgrades every
 * entry IN PLACE to `sorobanCredentialsAddressV2` (auth-payload.js:65-67), and
 * throws unless the payload is V2/with-delegates. So V2 is the REAL production
 * shape; V1 is a legacy/attacker-constructable shape. Fixtures cover all three
 * address-bound variants plus source-account, so a kit shape-change (or a
 * regression to a V1-only filter) breaks a test rather than hiding. */
export type CredKind = "v1" | "v2" | "delegates" | "source";

/** The SorobanAddressCredentials struct all three address-bound variants wrap. */
function addressCreds(subject: string, nonce = "0", expiration = 0): xdr.SorobanAddressCredentials {
  return new xdr.SorobanAddressCredentials({
    address: Address.fromString(subject).toScAddress(),
    nonce: xdr.Int64.fromString(nonce),
    signatureExpirationLedger: expiration,
    signature: xdr.ScVal.scvVoid(),
  });
}

/** Build a credentials union for `subject` in the requested variant. V2 mirrors
 * exactly what the kit's `toAddressBoundCredentials` produces:
 * `sorobanCredentialsAddressV2(<same SorobanAddressCredentials>)`. */
function credentialsFor(
  subject: string,
  kind: CredKind,
  nonce?: string,
  expiration?: number,
): xdr.SorobanCredentials {
  switch (kind) {
    case "source":
      return xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
    case "v1":
      return xdr.SorobanCredentials.sorobanCredentialsAddress(
        addressCreds(subject, nonce, expiration),
      );
    case "v2":
      return xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        addressCreds(subject, nonce, expiration),
      );
    case "delegates":
      return xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: addressCreds(subject, nonce, expiration),
          delegates: [],
        }),
      );
  }
}

/** Builds a single-op invokeHostFunction tx whose auth entries carry the given
 * (subject, credential-kind) pairs. `subjects` as string[] defaults every entry
 * to V2 — the real production shape — so tests read as "what the kit produces"
 * unless a kind is stated explicitly. */
export function buildInvokeTx(
  subjects: Array<
    string | { subject: string; kind?: CredKind; nonce?: string; expiration?: number }
  >,
  opts?: { sourceAccountCreds?: boolean },
): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
  const entries = subjects.map((s) =>
    typeof s === "string"
      ? { subject: s, kind: (opts?.sourceAccountCreds ? "source" : "v2") as CredKind }
      : { ...s, kind: s.kind ?? ("v2" as CredKind) },
  );
  const primary = Address.fromString(entries[0]?.subject ?? OTHER_CONTRACT);

  const auth = entries.map(({ subject, kind, nonce, expiration }) => {
    const addr = Address.fromString(subject);
    return new xdr.SorobanAuthorizationEntry({
      credentials: credentialsFor(subject, kind, nonce, expiration),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: addr.toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
  });

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: primary.toScAddress(),
        functionName: "transfer",
        args: [],
      }),
    ),
    auth,
  });

  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}
