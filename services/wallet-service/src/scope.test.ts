import { Account, Address, Keypair, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { extractAddressAuthSubjects, ScopeError, assertScopedToKnownWallets } from "./scope";

const PASSPHRASE = "Test SDF Network ; September 2015";

// A valid Vellar-style smart-account C-address and an unrelated contract.
const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

/** Builds a signed-shaped single-op invokeHostFunction tx whose auth entries
 * carry address credentials bound to the given contract subjects. */
function buildInvokeTx(subjects: string[], opts?: { sourceAccountCreds?: boolean }): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
  const primary = Address.fromString(subjects[0] ?? OTHER_CONTRACT);

  const auth = subjects.map((subject) => {
    const addr = Address.fromString(subject);
    const credentials = opts?.sourceAccountCreds
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: addr.toScAddress(),
            nonce: xdr.Int64.fromString("0"),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        );
    return new xdr.SorobanAuthorizationEntry({
      credentials,
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

describe("extractAddressAuthSubjects", () => {
  it("returns every address-credential subject in the tx", () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    const subjects = extractAddressAuthSubjects(xdrStr, PASSPHRASE);
    expect(subjects).toEqual([KNOWN_WALLET, OTHER_CONTRACT]);
  });

  it("ignores source-account credentials (a deploy carries no address subject)", () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET], { sourceAccountCreds: true });
    expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([]);
  });

  it("returns [] for an unparseable xdr rather than throwing", () => {
    expect(extractAddressAuthSubjects("not-an-xdr", PASSPHRASE)).toEqual([]);
  });
});

describe("assertScopedToKnownWallets", () => {
  const knownOnly = async (contractId: string) => contractId === KNOWN_WALLET;

  it("passes when every address subject is a known wallet", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).resolves.toBeUndefined();
  });

  it("rejects when any address subject is NOT a known wallet (covers both submitter branches)", async () => {
    const xdrStr = buildInvokeTx([OTHER_CONTRACT]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("rejects a tx mixing a known wallet with an unknown contract", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("rejects a tx with NO address-credential subject at all (nothing to attribute the spend to)", async () => {
    // A source-account-auth invoke has no address subject; the relayer/sponsor
    // must not fund a tx we cannot attribute to a known wallet.
    const xdrStr = buildInvokeTx([KNOWN_WALLET], { sourceAccountCreds: true });
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).rejects.toBeInstanceOf(ScopeError);
  });
});
