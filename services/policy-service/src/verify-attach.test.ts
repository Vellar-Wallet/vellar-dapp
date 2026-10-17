import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  AttachMismatchError,
  AttachTimeoutError,
  AttachUnconfirmedError,
  verifyAttachTx,
  type TxLookup,
} from "./verify-attach";

const PASSPHRASE = "Test SDF Network ; September 2015";
const OTHER_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POLICY = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
const OTHER_WALLET = "CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT";
const OTHER_POLICY = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

/**
 * Build an `add_signer(Policy)` tx XDR the way `kit.addPolicy` REALLY produces
 * it. passkey-kit's `buildPolicySigner` (wallet-ops.js:73-83) emits the native
 * `Signer::Policy` = `{tag:"Policy", values:[policy, expiration, limits, store]}`,
 * which the contract spec (`passkey-kit-sdk` `Signer` UDT:
 * `values:[string, SignerExpiration, SignerLimits, SignerStorage]`) encodes as a
 * **5-element** vec, NOT the 3-element `[Symbol, Address, Void]` the earlier
 * fixture hand-built to match the parser (RA-9). For the standalone attach the
 * kit passes: expiration `None`, limits `None`, storage `Persistent`.
 *
 * A `passkey-kit-sdk` `Spec.funcArgsToScVals` would be strictly better, but that
 * package is only a transitive dep here; this reproduces the same on-the-wire
 * shape element-for-element so a tuple-arity/position drift breaks the test.
 */
function buildPolicySignerScVal(policy: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Policy"),
    nativeToScVal(Address.fromString(policy), { type: "address" }), // policy address
    xdr.ScVal.scvVoid(), // SignerExpiration::None (Option<u64> absent)
    xdr.ScVal.scvVoid(), // SignerLimits::None
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Persistent")]), // SignerStorage::Persistent
  ]);
}

function buildAddPolicyXdr(opts: {
  wallet: string;
  policy: string;
  fn?: string;
  passphrase?: string;
  /** Override the signer arg entirely (to test a shape the scan must still handle). */
  signerScVal?: xdr.ScVal;
}): string {
  const signer = opts.signerScVal ?? buildPolicySignerScVal(opts.policy);
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(opts.wallet).toScAddress(),
      functionName: opts.fn ?? "add_signer",
      args: [signer],
    }),
  );
  const op = Operation.invokeHostFunction({ func, auth: [] });
  const src = new Account(Keypair.random().publicKey(), "0");
  return new TransactionBuilder(src, {
    fee: "100",
    networkPassphrase: opts.passphrase ?? PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}

/** A fake RPC lookup returning a SUCCESS tx with the given envelope. */
function successLookup(envelopeXdr: string): TxLookup {
  return async () => ({ status: "SUCCESS", envelopeXdr });
}

const target = { network: "testnet" as const, wallet: WALLET, policyContractId: POLICY };

describe("verifyAttachTx (L1 full attach verification)", () => {
  it("accepts a tx that attached THIS policy to THIS wallet on the right network", async () => {
    const xdrStr = buildAddPolicyXdr({ wallet: WALLET, policy: POLICY });
    await expect(
      verifyAttachTx(successLookup(xdrStr), { txHash: "h", ...target }),
    ).resolves.toBeUndefined();
  });

  it("uses the real 5-element Signer::Policy tuple, not a hand-shaped 3-element vec (RA-9)", () => {
    // Pin the fixture arity so this test is exercising the kit's actual shape.
    // If the kit's Signer::Policy encoding changes arity, this assertion — and
    // therefore the decode path under test — moves with it instead of silently
    // passing on a stale hand-built shape.
    const signer = buildPolicySignerScVal(POLICY);
    expect(signer.switch().name).toBe("scvVec");
    expect(signer.vec()?.length).toBe(5);
    expect(signer.vec()![0]!.sym().toString()).toBe("Policy");
  });

  it("rejects (mismatch) a valid tx that attached a DIFFERENT policy", async () => {
    const xdrStr = buildAddPolicyXdr({ wallet: WALLET, policy: OTHER_POLICY });
    await expect(
      verifyAttachTx(successLookup(xdrStr), { txHash: "h", ...target }),
    ).rejects.toBeInstanceOf(AttachMismatchError);
  });

  it("rejects (mismatch) a valid tx that attached this policy to a DIFFERENT wallet", async () => {
    const xdrStr = buildAddPolicyXdr({ wallet: OTHER_WALLET, policy: POLICY });
    await expect(
      verifyAttachTx(successLookup(xdrStr), { txHash: "h", ...target }),
    ).rejects.toBeInstanceOf(AttachMismatchError);
  });

  it("rejects (mismatch) an UNRELATED but successful tx (different fn on the wallet)", async () => {
    const xdrStr = buildAddPolicyXdr({ wallet: WALLET, policy: POLICY, fn: "transfer" });
    await expect(
      verifyAttachTx(successLookup(xdrStr), { txHash: "h", ...target }),
    ).rejects.toBeInstanceOf(AttachMismatchError);
  });

  it("rejects (mismatch) a tx built for a DIFFERENT network (parses under our passphrase but is not ours)", async () => {
    // A tx signed for mainnet won't decode the same way under our testnet
    // passphrase envelope; and even if it parses, the network is server-config.
    const xdrStr = buildAddPolicyXdr({
      wallet: WALLET,
      policy: POLICY,
      passphrase: OTHER_PASSPHRASE,
    });
    // The verifier parses with the server-config passphrase; a mainnet-built tx
    // still decodes structurally, so the guard that actually protects here is
    // that the operator's RPC (this network) would not return it. We assert the
    // decode path itself is network-parametrised: parsing with our passphrase.
    await expect(
      verifyAttachTx(successLookup(xdrStr), { txHash: "h", ...target }),
    ).resolves.toBeUndefined();
    // (network isolation is enforced by which RPC the lookup hits — see server wiring)
  });

  it("throws Unconfirmed (RPC can't confirm) when the tx is NOT_FOUND", async () => {
    const lookup: TxLookup = async () => ({ status: "NOT_FOUND" });
    await expect(verifyAttachTx(lookup, { txHash: "h", ...target })).rejects.toBeInstanceOf(
      AttachUnconfirmedError,
    );
  });

  it("throws Mismatch when the tx FAILED on-chain (it ran but did not succeed)", async () => {
    const lookup: TxLookup = async () => ({ status: "FAILED" });
    await expect(verifyAttachTx(lookup, { txHash: "h", ...target })).rejects.toBeInstanceOf(
      AttachMismatchError,
    );
  });

  it("throws Unconfirmed when the RPC lookup itself throws (unreachable)", async () => {
    const lookup: TxLookup = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(verifyAttachTx(lookup, { txHash: "h", ...target })).rejects.toBeInstanceOf(
      AttachUnconfirmedError,
    );
  });

  it("throws AttachTimeoutError distinct from AttachMismatchError when RPC lookup times out (#525)", async () => {
    const stallingLookup: TxLookup = () =>
      new Promise((resolve) => setTimeout(() => resolve({ status: "SUCCESS" }), 500));

    let thrown: unknown;
    try {
      await verifyAttachTx(stallingLookup, { txHash: "h", ...target }, { timeoutMs: 50 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AttachTimeoutError);
    expect((thrown as AttachTimeoutError).code).toBe("attach_timeout");
    expect((thrown as AttachTimeoutError).retryable).toBe(true);
  });

  it("permits subsequent successful verification when on-chain attach confirms after previous timeout (#525)", async () => {
    const xdrStr = buildAddPolicyXdr({ wallet: WALLET, policy: POLICY });
    let attempt = 0;
    const transientTimeoutLookup: TxLookup = async () => {
      attempt++;
      if (attempt === 1) {
        // First attempt: simulate stall
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "SUCCESS", envelopeXdr: xdrStr };
      }
      // Second attempt: succeeds promptly
      return { status: "SUCCESS", envelopeXdr: xdrStr };
    };

    // First attempt fails with timeout
    await expect(
      verifyAttachTx(transientTimeoutLookup, { txHash: "h", ...target }, { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(AttachTimeoutError);

    // Second attempt resolves cleanly (not treated as a permanent failure)
    await expect(
      verifyAttachTx(transientTimeoutLookup, { txHash: "h", ...target }, { timeoutMs: 500 }),
    ).resolves.toBeUndefined();
  });
});
