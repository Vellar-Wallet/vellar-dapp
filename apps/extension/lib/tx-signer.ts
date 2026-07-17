import { Buffer } from "buffer";
import type { Signer } from "passkey-kit";
import { signWithDeviceKey } from "./device-key";
import type { PairedWallet } from "./state";

// Transaction signing with the device signer (docs/decisions.md option 1A).
// passkey-kit does the auth-entry mechanics (payload hashing, expiration,
// contract-ABI signature encoding); we supply a Signer backed by the
// NON-EXTRACTABLE WebCrypto key. Mirrors passkey-kit's own Ed25519Signer
// (dist/signers.js): key/value = { tag: "Ed25519", values: [bytes] }.

const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export function createDeviceSigner(pair: CryptoKeyPair, rawPublicKey: Uint8Array): Signer {
  return {
    async sign(payload: Buffer) {
      const signature = await signWithDeviceKey(pair, new Uint8Array(payload));
      return {
        key: { tag: "Ed25519", values: [Buffer.from(rawPublicKey)] },
        value: { tag: "Ed25519", values: [Buffer.from(signature)] },
      };
    },
  };
}

export class PairedWalletMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Paired wallet is ${expected} but the passkey resolves to ${actual ?? "nothing"}`);
    this.name = "PairedWalletMismatchError";
  }
}

/**
 * Signs every auth entry of the transaction that the paired wallet must
 * authorize, using the device key, and returns the signed XDR. Attaches the
 * kit via connectWallet({ keyId }) — no WebAuthn ceremony; the kit verifies
 * on-chain that the keyId is a live signer of the resolved wallet.
 */
export async function signTransactionXdr(input: {
  xdr: string;
  wallet: PairedWallet;
  deviceKeyPair: CryptoKeyPair;
  deviceRawPublicKey: Uint8Array;
}): Promise<string> {
  const { wallet } = input;
  const networkPassphrase = NETWORK_PASSPHRASES[wallet.network];

  const [{ PasskeyKit }, { Address, TransactionBuilder }] = await Promise.all([
    import("passkey-kit"),
    import("@stellar/stellar-sdk"),
  ]);

  const kit = new PasskeyKit({
    rpcUrl: wallet.rpcUrl,
    networkPassphrase,
    walletWasmHash: wallet.walletWasmHash,
  });
  await kit.connectWallet({ keyId: wallet.keyId });
  if (kit.contractId !== wallet.address) {
    throw new PairedWalletMismatchError(wallet.address, kit.contractId);
  }

  const tx = TransactionBuilder.fromXDR(input.xdr, networkPassphrase);
  if (!("operations" in tx)) {
    throw new Error("Fee-bump transactions cannot be signed by the extension");
  }

  const signer = createDeviceSigner(input.deviceKeyPair, input.deviceRawPublicKey);
  let signedAny = false;

  for (const operation of tx.operations) {
    if (operation.type !== "invokeHostFunction" || !operation.auth) continue;
    for (let i = 0; i < operation.auth.length; i++) {
      const entry = operation.auth[i]!;
      if (entry.credentials().switch().name !== "sorobanCredentialsAddress") continue;
      const entryAddress = Address.fromScAddress(
        entry.credentials().address().address(),
      ).toString();
      if (entryAddress !== wallet.address) continue;
      operation.auth[i] = await kit.signAuthEntry(entry, signer);
      signedAny = true;
    }
  }

  if (!signedAny) {
    throw new Error("The transaction has no auth entries for the paired wallet");
  }

  return tx.toXDR();
}
