import {
  createPasskeyKitConnector,
  createPaymentClient,
  defaultSignedToXdr,
  resumeKitConnection,
  type PasskeyKitLike,
  type PaymentClient,
  type SacClientLike,
  type WalletConnector,
} from "vellar-sdk";
import { walletConfig } from "./config";
import { createHttpWalletBackend } from "./http-backend";
import { createPolicySignerActions } from "./policy-signer";
import { createSwapClient, type SwapClient } from "./swap/client";
import { createSoroswapVenue } from "./swap/soroswap";
import { createSignerActions, type AddAgentKeyInput } from "./signer-actions";
import { createWalletUpgradeActions, type WalletVersionStatus } from "./wallet-upgrade";
import type { RawSigner, SignerKeyRef } from "./signer-model";

// Builds the real PasskeyKit-backed wallet runtime. The connector and the
// payment client MUST share one PasskeyKit instance — the connected passkey's
// state lives inside it. passkey-kit touches browser APIs, so everything is
// imported lazily at interaction time — never during SSR.

export interface WalletRuntime {
  connector: WalletConnector;
  payments: PaymentClient;
  /** Soroswap swaps, signed by the same kit and submitted through the same backend. */
  swaps: SwapClient;
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
  /**
   * Detaches a policy signer from the smart account: passkey-signed kit.remove
   * of SignerKey.Policy. Because the policy is a standalone signer, the wallet's
   * self-removal exception lets the admin passkey remove it WITHOUT the policy's
   * consent — the recovery path for a wallet stuck behind a reject-everything
   * policy (security-audit.md V3 / FIX 5). Returns the tx hash.
   */
  detachPolicy(policyContractId: string): Promise<{ hash: string }>;
  /**
   * The account's signer set as the chain has it (#401): enumerated through
   * passkey-kit's hosted signer indexer (an index of the wallet's own
   * SignerAdded/SignerRemoved events), then every non-removed entry is
   * CONFIRMED with a direct ledger read (`kit.getSigner`) so a stale index can
   * neither hide a live signer nor show a revoked one as live. Requires a
   * connected/resumed kit.
   */
  listSigners(accountId: string): Promise<RawSigner[]>;
  /**
   * Add a second passkey (#401): browser registration ceremony for the NEW
   * credential, then the EXISTING passkey signs the wallet's add_signer for it
   * (Persistent, unlimited, non-expiring — a full admin peer, i.e. a recovery
   * passkey). Returns the tx hash and the new credential id.
   */
  addPasskeySigner(label: string): Promise<{ hash: string; keyId: string }>;
  /**
   * Mint an agent session key (#394): passkey-signed addEd25519 whose
   * SignerLimits name the token-budget policy as a REQUIRED co-signer, so the
   * chain — not this client — bounds what the key can spend.
   */
  addAgentKey(input: AddAgentKeyInput): Promise<{ hash: string }>;
  /**
   * On-chain removal of any signer (#401): passkey-signed remove_signer. The
   * wallet contract itself refuses to remove the last durable admin signer
   * (LastAdminSigner / LastSigner), which is the lockout guard of record.
   */
  removeSigner(key: SignerKeyRef): Promise<{ hash: string }>;
  /**
   * The wallet contract's on-chain wasm hash vs the hash this app build is
   * pinned to (open-work 5.1). Read-only ledger lookup; no prompt.
   */
  walletVersion(accountId: string): Promise<WalletVersionStatus>;
  /**
   * Upgrade the wallet contract to the pinned `walletWasmHash` (open-work
   * 5.1): passkey-signed `kit.upgrade(newWasmHash)`. The target is never
   * caller-supplied. Returns the tx hash and the from/to wasm hashes.
   */
  upgradeWallet(
    accountId: string,
  ): Promise<{ hash: string; fromWasmHash: string; toWasmHash: string }>;
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
      import("vellar-sdk/rpc"),
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
      swaps: createSwapClient({
        venue: createSoroswapVenue({
          network: config.network,
          rpcUrl: config.rpcUrl,
          networkPassphrase: config.networkPassphrase,
        }),
        kit: kit as unknown as { sign(tx: unknown): Promise<unknown> },
        backend,
        network: config.network,
        signedToXdr: defaultSignedToXdr,
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
      // Policy attach/detach is wired through createPolicySignerActions
      // (policy-signer.ts) so the standalone-signer + recovery-key invariants
      // are unit-tested at the WIRING layer (RA-6), not just at the pure
      // policyAttachArgs. The browser-only passkey-kit enums are injected.
      async attachPolicy(policyContractId) {
        const { SignerKey, SignerStore } = await import("passkey-kit");
        return policySignerActions({ SignerKey, SignerStore }).attachPolicy(policyContractId);
      },
      async detachPolicy(policyContractId) {
        const { SignerKey, SignerStore } = await import("passkey-kit");
        return policySignerActions({ SignerKey, SignerStore }).detachPolicy(policyContractId);
      },
      async listSigners(accountId) {
        const { MercuryIndexer, SignerKey } = await import("passkey-kit");
        const indexer = MercuryIndexer.forNetwork({ rpc: kit.rpc }, config.networkPassphrase);
        if (!indexer) throw new Error("No signer indexer is available for this network.");
        const indexed = await indexer.getSigners(accountId);
        // Confirm against the ledger: the indexer says what WAS added; the
        // ledger says what IS there now.
        const confirmed: RawSigner[] = [];
        for (const signer of indexed.slice(0, MAX_SIGNERS_CONFIRMED)) {
          if (signer.status === "removed") continue;
          const live = await kit.getSigner(signerKeyFrom(SignerKey, signer.key));
          if (live === null) continue;
          confirmed.push({
            key: { key: signer.key.key, value: signer.key.value },
            expiration: signer.expiration,
            limits: signer.limits,
            storage: signer.storage,
            status: signer.status,
          });
        }
        return confirmed;
      },
      async addPasskeySigner(label) {
        const { SignerKey, SignerStore } = await import("passkey-kit");
        return signerActions({ SignerKey, SignerStore }).addPasskeySigner(label);
      },
      async addAgentKey(input) {
        const { SignerKey, SignerStore } = await import("passkey-kit");
        return signerActions({ SignerKey, SignerStore }).addAgentKey(input);
      },
      async removeSigner(key) {
        const { SignerKey, SignerStore } = await import("passkey-kit");
        return signerActions({ SignerKey, SignerStore }).removeSigner(key);
      },
      walletVersion: (accountId) => upgradeActions().status(accountId),
      upgradeWallet: (accountId) => upgradeActions().upgrade(accountId),
    };

    /** Bind the extracted upgrade actions (wallet-upgrade.ts) to this
     * runtime's kit + backend, with a direct ledger read of the wallet
     * contract instance for its current wasm hash. */
    function upgradeActions() {
      return createWalletUpgradeActions({
        kit: {
          upgrade: (newWasmHash) => kit.upgrade(Buffer.from(newWasmHash)),
          sign: (tx) => kit.sign(tx as never),
        },
        backend,
        network: config.network,
        targetWasmHash: config.walletWasmHash,
        readWalletWasmHash: (accountId) => readContractWasmHash(config.rpcUrl, accountId),
      });
    }

    /** Bind the extracted signer actions (signer-actions.ts) to this
     * runtime's kit + backend + network. Same RA-6 rationale as policy
     * actions: the exact kit calls are unit-tested with a fake kit. */
    function signerActions(enums: {
      SignerKey: Parameters<typeof createSignerActions>[0]["SignerKey"];
      SignerStore: { Persistent: unknown; Temporary: unknown };
    }) {
      return createSignerActions({
        kit: {
          createKey: async (appName, userName) => {
            const created = await kit.createKey(appName, userName);
            return { keyId: created.keyId, publicKey: created.publicKey };
          },
          addSecp256r1: (keyId, publicKey, limits, store, expiration) =>
            kit.addSecp256r1(keyId, publicKey, limits, store as SignerStoreValue, expiration),
          addEd25519: (publicKey, limits, store, expiration) =>
            kit.addEd25519(
              publicKey,
              limits as SignerLimitsValue,
              store as SignerStoreValue,
              expiration,
            ),
          remove: (signerKey) => kit.remove(signerKey as SignerKeyValue),
          sign: (tx) => kit.sign(tx as never),
        },
        backend,
        network: config.network,
        appName: config.appName,
        SignerKey: enums.SignerKey,
        SignerStore: enums.SignerStore,
      });
    }

    /** Bind the extracted actions to this runtime's kit + backend + network,
     * given the lazily-imported passkey-kit enums. */
    function policySignerActions(enums: {
      SignerKey: { Policy(id: string): unknown };
      SignerStore: { Persistent: unknown; Temporary: unknown };
    }) {
      return createPolicySignerActions({
        kit: kit as unknown as Parameters<typeof createPolicySignerActions>[0]["kit"],
        backend,
        network: config.network,
        SignerKey: enums.SignerKey,
        SignerStore: enums.SignerStore,
      });
    }
  })();
  return runtimePromise;
}

/** Upper bound on indexer rows confirmed per listing (one ledger read each). */
const MAX_SIGNERS_CONFIRMED = 64;

type SignerStoreValue = Parameters<import("passkey-kit").PasskeyKit["addEd25519"]>[2];
type SignerLimitsValue = Parameters<import("passkey-kit").PasskeyKit["addEd25519"]>[1];
type SignerKeyValue = Parameters<import("passkey-kit").PasskeyKit["remove"]>[0];

/** A contract's current wasm hash (hex), read from its instance ledger entry. */
async function readContractWasmHash(rpcUrl: string, contractId: string): Promise<string> {
  const { rpc, xdr } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(rpcUrl);
  const entry = await server.getContractData(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent,
  );
  const executable = entry.val.contractData().val().instance().executable();
  if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
    throw new Error(`${contractId} is not a wasm contract.`);
  }
  return Buffer.from(executable.wasmHash()).toString("hex");
}

/** Rebuild a passkey-kit SignerKey from the indexer's {key,value} view. */
function signerKeyFrom(
  SignerKey: typeof import("passkey-kit").SignerKey,
  key: { key: "Policy" | "Ed25519" | "Secp256r1"; value: string },
) {
  switch (key.key) {
    case "Policy":
      return SignerKey.Policy(key.value);
    case "Ed25519":
      return SignerKey.Ed25519(key.value);
    case "Secp256r1":
      return SignerKey.Secp256r1(key.value);
  }
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

/** Swap client with the kit connection resumed for the given session key. */
export async function getRealSwapClient(keyId: string | undefined): Promise<SwapClient> {
  const runtime = await getWalletRuntime();
  if (keyId) await runtime.resume(keyId);
  return runtime.swaps;
}
