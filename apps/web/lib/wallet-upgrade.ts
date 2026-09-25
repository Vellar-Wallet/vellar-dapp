// Wallet contract upgrade WIRING (open-work 5.1), extracted the same way
// signer-actions.ts and policy-signer.ts are (RA-6): the code that decides
// EXACTLY what the kit is asked to sign lives here, behind a structural kit
// interface, so it can be exercised with a fake kit.
//
// The flow: read the wallet's on-chain wasm hash, compare it to the hash this
// build of the app is pinned to (`walletWasmHash` — the passkey-kit matched
// pair, see config.ts), and — only if they differ — have the kit build the
// wallet's own `upgrade(new_wasm_hash)`. `kit.sign` runs the ONLY passkey
// prompt; the signed XDR goes to our backend for submission. The wallet's
// `upgrade` is admin-gated by its own `__check_auth`, so the chain — not this
// client — is what refuses a non-admin signer.
//
// The target hash is NEVER user-supplied: it is always the app's pinned
// `walletWasmHash`. Letting a caller choose the target would turn this into a
// "replace my wallet's code with anything" button.

export interface UpgradeKit {
  upgrade(newWasmHash: Uint8Array): Promise<unknown>;
  sign(tx: unknown): Promise<unknown>;
}

export interface UpgradeBackend {
  submitTransaction(req: { signedXdr: string; network: string }): Promise<{ hash: string }>;
}

export interface WalletUpgradeDeps {
  kit: UpgradeKit;
  backend: UpgradeBackend;
  network: string;
  /** The wasm hash this app build targets (hex). */
  targetWasmHash: string;
  /** Reads the wallet contract's CURRENT on-chain wasm hash (hex). */
  readWalletWasmHash(accountId: string): Promise<string>;
}

export type WalletVersionStatus =
  | { state: "current"; currentHash: string; targetHash: string }
  | { state: "upgrade-available"; currentHash: string; targetHash: string };

const WASM_HASH_RE = /^[0-9a-f]{64}$/;

/** Lower-case, strip an optional 0x prefix, and require 32 bytes of hex. */
export function normalizeWasmHash(hash: string): string {
  const normalized = hash.trim().toLowerCase().replace(/^0x/, "");
  if (!WASM_HASH_RE.test(normalized)) {
    throw new Error(`Not a valid wasm hash (expected 64 hex characters): ${hash}`);
  }
  return normalized;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = normalizeWasmHash(hex);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function walletVersionStatus(currentHash: string, targetHash: string): WalletVersionStatus {
  const current = normalizeWasmHash(currentHash);
  const target = normalizeWasmHash(targetHash);
  return current === target
    ? { state: "current", currentHash: current, targetHash: target }
    : { state: "upgrade-available", currentHash: current, targetHash: target };
}

export class WalletAlreadyCurrentError extends Error {
  constructor(hash: string) {
    super(`The wallet already runs wasm ${hash}; there is nothing to upgrade.`);
    this.name = "WalletAlreadyCurrentError";
  }
}

function toXdr(signed: unknown, fallback: unknown): string {
  const value = signed ?? fallback;
  return typeof value === "string" ? value : (value as { toXDR(): string }).toXDR();
}

export function createWalletUpgradeActions(deps: WalletUpgradeDeps) {
  const targetHash = normalizeWasmHash(deps.targetWasmHash);

  async function status(accountId: string): Promise<WalletVersionStatus> {
    return walletVersionStatus(await deps.readWalletWasmHash(accountId), targetHash);
  }

  return {
    status,

    /**
     * Passkey-approved `upgrade(targetWasmHash)` on the connected wallet.
     * Re-reads the on-chain hash immediately before building so a stale UI
     * (already upgraded on another device) never submits a no-op upgrade.
     * Resolves once the transaction is SUBMITTED — callers track it to final.
     */
    async upgrade(
      accountId: string,
    ): Promise<{ hash: string; fromWasmHash: string; toWasmHash: string }> {
      const current = await status(accountId);
      if (current.state === "current") throw new WalletAlreadyCurrentError(current.currentHash);

      const tx = await deps.kit.upgrade(hexToBytes(targetHash));
      const signed = await deps.kit.sign(tx);
      const { hash } = await deps.backend.submitTransaction({
        signedXdr: toXdr(signed, tx),
        network: deps.network,
      });
      return { hash, fromWasmHash: current.currentHash, toWasmHash: targetHash };
    },
  };
}

/** User-facing copy for upgrade failures; falls back to the generic message. */
export function walletUpgradeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof WalletAlreadyCurrentError) {
    return "Your wallet is already on the latest version. Nothing was changed.";
  }
  const message = err instanceof Error ? err.message : String(err);
  // Host error when the target wasm was never uploaded to this network.
  if (/wasm.*(not found|missing)|MissingValue/i.test(message)) {
    return "The new wallet version isn't available on this network yet. Nothing was changed.";
  }
  return fallback;
}
