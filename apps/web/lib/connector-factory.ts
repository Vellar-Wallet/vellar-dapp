import {
  createPasskeyKitConnector,
  createPaymentClient,
  resumeKitConnection,
  type PasskeyKitLike,
  type PaymentClient,
  type SacClientLike,
  type WalletConnector,
} from "@vela/wallet-sdk";
import { walletConfig } from "./config";
import { createHttpWalletBackend } from "./http-backend";

// Builds the real PasskeyKit-backed wallet runtime. The connector and the
// payment client MUST share one PasskeyKit instance — the connected passkey's
// state lives inside it. passkey-kit touches browser APIs, so everything is
// imported lazily at interaction time — never during SSR.

export interface WalletRuntime {
  connector: WalletConnector;
  payments: PaymentClient;
  /**
   * Re-attaches the kit to the session's wallet after a page reload (no
   * WebAuthn prompt). Must run before signer operations or kit.sign throws
   * WalletNotConnectedError.
   */
  resume(keyId: string): Promise<void>;
  /**
   * Adds an extension device signer to the smart account (docs/decisions.md
   * option 1A): passkey-signed addEd25519 with an on-chain expiration, so the
   * pairing is a session, not a permanent co-owner. Returns the tx hash and
   * the expiry time.
   */
  addDeviceSigner(devicePublicKeyHex: string): Promise<{ hash: string; expiresAt: string }>;
  /**
   * Attaches an already-deployed policy contract instance to the smart account
   * as a policy signer (Phase 5): passkey-signed kit.addPolicy, which runs the
   * contract's `install` hook. The instance must already be deployed and bound
   * to this wallet (policy-service /deploy-instance). Returns the tx hash.
   */
  attachPolicy(policyContractId: string): Promise<{ hash: string }>;
}

/** 7 days — the device-signer session length. The contract stores the
 * expiration as a unix-seconds timestamp (Option<u64>), NOT a ledger number. */
export const DEVICE_SIGNER_SESSION_SECONDS = 7 * 24 * 60 * 60;

let runtimePromise: Promise<WalletRuntime> | undefined;

export function getWalletRuntime(): Promise<WalletRuntime> {
  runtimePromise ??= (async () => {
    const config = walletConfig();
    const [{ PasskeyKit, SACClient }, { isValidStellarAddress }] = await Promise.all([
      import("passkey-kit"),
      import("@vela/wallet-sdk/rpc"),
    ]);

    const kit = new PasskeyKit({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      walletWasmHash: config.walletWasmHash,
    });
    const backend = createHttpWalletBackend(config.apiUrl);

    // Structural bridges to our seams; runtime shape verified against
    // passkey-kit v0.13 (docs/decisions.md) and exercised by the testnet e2e flow.
    const kitLike = kit as unknown as PasskeyKitLike;
    const sac = new SACClient({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
    }) as unknown as SacClientLike;

    return {
      connector: createPasskeyKitConnector({
        kit: kitLike,
        backend,
        network: config.network,
        appName: config.appName,
      }),
      payments: createPaymentClient({
        kit: kitLike,
        sac,
        backend,
        network: config.network,
        isValidAddress: isValidStellarAddress,
      }),
      resume: (keyId) => resumeKitConnection(kitLike, keyId),
      async addDeviceSigner(devicePublicKeyHex) {
        const { SignerStore } = await import("passkey-kit");
        const { StrKey } = await import("@stellar/stellar-sdk");
        const publicKey = StrKey.encodeEd25519PublicKey(Buffer.from(devicePublicKeyHex, "hex"));
        // Unix-seconds timestamp, per the contract's Option<u64> expiration.
        const expirationSeconds = Math.floor(Date.now() / 1000) + DEVICE_SIGNER_SESSION_SECONDS;
        // Unlimited within the session for MVP; Phase 5 policies add limits.
        const tx = await kit.addEd25519(
          publicKey,
          undefined,
          SignerStore.Temporary,
          expirationSeconds,
        );
        const signed = (await kit.sign(tx)) ?? tx;
        const { hash } = await backend.submitTransaction({
          signedXdr: typeof signed === "string" ? signed : (signed as { toXDR(): string }).toXDR(),
          network: config.network,
        });
        return { hash, expiresAt: new Date(expirationSeconds * 1000).toISOString() };
      },
      async attachPolicy(policyContractId) {
        const { SignerStore } = await import("passkey-kit");
        // A policy signer carries its own on-chain constraint, so it needs no
        // SignerLimits and no expiration (revoked by removing the signer).
        // Persistent so it survives as a durable rule on the account.
        const tx = await kit.addPolicy(
          policyContractId,
          undefined,
          SignerStore.Persistent,
          undefined,
        );
        const signed = (await kit.sign(tx)) ?? tx;
        const { hash } = await backend.submitTransaction({
          signedXdr: typeof signed === "string" ? signed : (signed as { toXDR(): string }).toXDR(),
          network: config.network,
        });
        return { hash };
      },
    };
  })();
  return runtimePromise;
}

export function createRealConnector(): Promise<WalletConnector> {
  return getWalletRuntime().then((runtime) => runtime.connector);
}

/** Payment client with the kit connection resumed for the given session key. */
export async function getRealPaymentClient(keyId: string | undefined): Promise<PaymentClient> {
  const runtime = await getWalletRuntime();
  if (keyId) await runtime.resume(keyId);
  return runtime.payments;
}
