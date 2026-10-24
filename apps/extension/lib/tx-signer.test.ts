import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { MAX_EXPIRATION_LEDGERS } from "./signer-expiration";
import type { PairedWallet } from "./state";

// Spy on the device-key signing step (#698) so a test can assert whether the
// client-side ceremony was even reached, independent of whether the kit
// later accepts or rejects the result.
const signWithDeviceKeyMock = vi.fn(async () => new Uint8Array(64));
vi.mock("./device-key", () => ({
  signWithDeviceKey: signWithDeviceKeyMock,
}));

const PASSPHRASE = "Test SDF Network ; September 2015";

function contractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

const WALLET = contractId();

// Capture what signAuthEntry receives, and prove the caller's rpcUrl is never
// used to derive the expiration anchor. The kit is mocked at the module seam:
// connectWallet resolves to the paired address; signAuthEntry records options
// and returns the entry unchanged (we assert on the recorded expiration).
const signAuthEntryCalls: Array<{ expiration?: number }> = [];

// Test-controllable failure hooks (#698): default to the happy path; a given
// test overrides one to simulate the kit itself rejecting at that seam.
// Reset in beforeEach so one test's override never leaks into the next.
const kitHooks: {
  connectWallet: () => Promise<{ contractId: string }> | never;
  signAuthEntry: () => void;
} = {
  connectWallet: async () => ({ contractId: WALLET }),
  signAuthEntry: () => {},
};

vi.mock("passkey-kit", () => {
  class PasskeyKit {
    contractId = WALLET;
    constructor(_config: unknown) {}
    async connectWallet(_opts: unknown) {
      return kitHooks.connectWallet();
    }
    async signAuthEntry(
      entry: unknown,
      signer: { sign: (payload: Buffer) => Promise<unknown> },
      options?: { expiration?: number },
    ) {
      // The real kit calls the signer to produce the signature BEFORE doing
      // its own encoding/verification — mirror that ordering so a test can
      // simulate "the ceremony itself succeeded, the kit rejected after."
      await signer.sign(Buffer.from("payload"));
      kitHooks.signAuthEntry();
      signAuthEntryCalls.push({ expiration: options?.expiration });
      return entry;
    }
  }
  return { PasskeyKit };
});

// The credential shape to build. passkey-kit@0.14 signs V2 (upgrades V1 in place
// at auth-payload.js:67), so V2 is the REAL shape reaching the signer; the filter
// must match all address-bound variants (RA-1), not just the V1 string.
type CredKind = "v1" | "v2" | "delegates";

function walletAddressCreds(): xdr.SorobanAddressCredentials {
  return new xdr.SorobanAddressCredentials({
    address: Address.fromString(WALLET).toScAddress(),
    nonce: xdr.Int64.fromString("0"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
}

function walletCredentials(kind: CredKind): xdr.SorobanCredentials {
  switch (kind) {
    case "v1":
      return xdr.SorobanCredentials.sorobanCredentialsAddress(walletAddressCreds());
    case "v2":
      return xdr.SorobanCredentials.sorobanCredentialsAddressV2(walletAddressCreds());
    case "delegates":
      return xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: walletAddressCreds(),
          delegates: [],
        }),
      );
  }
}

// Build a single-op invokeHostFunction whose one auth entry is address-bound to
// WALLET, so the signer's filter matches it. Defaults to V2 — the real shape the
// kit produces — so the test exercises production traffic, not a legacy V1 shape.
function buildTxWithWalletAuth(kind: CredKind = "v2"): string {
  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: walletCredentials(kind),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId()).toScAddress(),
          functionName: "noop",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId()).toScAddress(),
        functionName: "noop",
        args: [],
      }),
    ),
    auth: [authEntry],
  });
  const src = new Account(Keypair.random().publicKey(), "0");
  return new TransactionBuilder(src, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}

const wallet: PairedWallet = {
  address: WALLET,
  network: "testnet",
  // A deliberately hostile rpcUrl: if the anchor came from here the test's
  // trusted-ledger fake would never be consulted.
  rpcUrl: "https://attacker.example/rpc",
  keyId: "key-1",
  walletWasmHash: "ab".repeat(32),
};

const deviceKeyPair = {} as CryptoKeyPair;
const deviceRawPublicKey = new Uint8Array(32);

describe("signTransactionXdr (L4 expiration binding)", () => {
  beforeEach(() => {
    signAuthEntryCalls.length = 0;
    signWithDeviceKeyMock.mockClear();
    kitHooks.connectWallet = async () => ({ contractId: WALLET });
    kitHooks.signAuthEntry = () => {};
  });

  it("passes a capped expiration anchored on the TRUSTED ledger, not the caller rpcUrl", async () => {
    const { signTransactionXdr } = await import("./tx-signer");
    const ANCHOR = 1_000_000;
    let trustedUrlSeen: string | undefined;

    await signTransactionXdr({
      xdr: buildTxWithWalletAuth(),
      wallet,
      deviceKeyPair,
      deviceRawPublicKey,
      getTrustedLatestLedger: async (rpcUrl) => {
        trustedUrlSeen = rpcUrl;
        return ANCHOR;
      },
    });

    // The anchor was fetched from the pinned testnet endpoint, NOT wallet.rpcUrl.
    expect(trustedUrlSeen).toBe("https://soroban-testnet.stellar.org");
    expect(trustedUrlSeen).not.toBe(wallet.rpcUrl);
    // Exactly one wallet auth entry signed, with the capped expiration.
    expect(signAuthEntryCalls).toEqual([{ expiration: ANCHOR + MAX_EXPIRATION_LEDGERS }]);
  });

  it("caps the window even when the trusted ledger reports an inflated anchor", async () => {
    const { signTransactionXdr } = await import("./tx-signer");
    const INFLATED = 3_000_000_000;

    await signTransactionXdr({
      xdr: buildTxWithWalletAuth(),
      wallet,
      deviceKeyPair,
      deviceRawPublicKey,
      getTrustedLatestLedger: async () => INFLATED,
    });

    expect(signAuthEntryCalls[0]!.expiration! - INFLATED).toBe(MAX_EXPIRATION_LEDGERS);
  });

  it("fails closed on mainnet when no trusted RPC is configured", async () => {
    const { signTransactionXdr } = await import("./tx-signer");
    await expect(
      signTransactionXdr({
        xdr: buildTxWithWalletAuth(),
        wallet: { ...wallet, network: "mainnet" },
        deviceKeyPair,
        deviceRawPublicKey,
        mainnetRpcUrl: undefined,
        getTrustedLatestLedger: async () => 1,
      }),
    ).rejects.toThrow(/trusted RPC/i);
    // Nothing was signed.
    expect(signAuthEntryCalls).toHaveLength(0);
  });

  // RA-1: the wallet's real auth entries are V2 (or with-delegates), not V1. The
  // signer must sign each address-bound variant bound to the paired wallet — a
  // V1-only filter would skip them and throw "no auth entries for the wallet".
  it.each(["v1", "v2", "delegates"] as const)(
    "signs the wallet's %s address-bound auth entry",
    async (kind) => {
      const { signTransactionXdr } = await import("./tx-signer");
      const signedXdr = await signTransactionXdr({
        xdr: buildTxWithWalletAuth(kind),
        wallet,
        deviceKeyPair,
        deviceRawPublicKey,
        getTrustedLatestLedger: async () => 1_000_000,
      });
      expect(typeof signedXdr).toBe("string");
      expect(signAuthEntryCalls).toHaveLength(1);
    },
  );

  // #698: a device-key ceremony that completes successfully (the WebCrypto
  // signature is produced) is a DISTINCT failure mode from the kit rejecting
  // what comes after — e.g. a stale sequence number the kit's own encoding
  // or on-chain-facing verification step catches. The user-facing error must
  // make clear the signing step itself succeeded; this failed somewhere past
  // it, not that nothing was ever signed.
  it("surfaces a clear, distinct error when signing succeeds client-side but the kit rejects the result (e.g. a stale sequence number)", async () => {
    const { signTransactionXdr } = await import("./tx-signer");
    kitHooks.signAuthEntry = () => {
      throw new Error("tx_bad_seq: stale sequence number");
    };

    await expect(
      signTransactionXdr({
        xdr: buildTxWithWalletAuth(),
        wallet,
        deviceKeyPair,
        deviceRawPublicKey,
        getTrustedLatestLedger: async () => 1_000_000,
      }),
    ).rejects.toThrow(/tx_bad_seq: stale sequence number/);

    // The device key WAS asked to sign — the ceremony itself succeeded.
    // The failure is distinctly the kit's rejection afterward, not a signing
    // failure, and not a "cancelled before it started" case either.
    expect(signWithDeviceKeyMock).toHaveBeenCalledTimes(1);
  });

  // The closest analog to "the ceremony is cancelled before reaching
  // submission" in this file's real architecture: connectWallet (resolving
  // the paired wallet) fails before any signing is ever attempted. The
  // device key must never be asked to sign in this case.
  it("never asks the device key to sign when connecting to the paired wallet fails before signing starts", async () => {
    const { signTransactionXdr } = await import("./tx-signer");
    kitHooks.connectWallet = async () => {
      throw new Error("ceremony aborted: wallet connection was cancelled");
    };

    await expect(
      signTransactionXdr({
        xdr: buildTxWithWalletAuth(),
        wallet,
        deviceKeyPair,
        deviceRawPublicKey,
        getTrustedLatestLedger: async () => 1_000_000,
      }),
    ).rejects.toThrow(/ceremony aborted/);

    expect(signWithDeviceKeyMock).not.toHaveBeenCalled();
    expect(signAuthEntryCalls).toHaveLength(0);
  });
});
