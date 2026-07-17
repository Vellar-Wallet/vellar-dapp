"use client";

import type { WalletSession } from "@vela/types";
import type { VelaProvider } from "@vela/provider-sdk";
import { walletConfig } from "./config";
import { getWalletRuntime } from "./connector-factory";

// Web-to-extension pairing (technical-doc.md §7.2; docs/decisions.md device
// signer): ask the injected extension provider for a device public key, then
// add it as an expiring on-chain signer with the user's passkey.

export function getInjectedProvider(): VelaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { vela?: VelaProvider }).vela;
}

export interface PairingResult {
  hash: string;
  expiresAt: string;
}

// Local record of the last pairing per wallet (display-only: the truth lives
// on-chain and in the extension; the status check below asks the extension).
const pairingKey = (address: string) => `vela.pairing.${address}`;

export function rememberPairing(address: string, result: PairingResult): void {
  try {
    window.localStorage.setItem(pairingKey(address), JSON.stringify(result));
  } catch {
    // Display-only cache — never let storage failures break pairing.
  }
}

export function recallPairing(address: string): PairingResult | undefined {
  try {
    const raw = window.localStorage.getItem(pairingKey(address));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PairingResult;
    return typeof parsed?.expiresAt === "string" && typeof parsed?.hash === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the extension whether it is paired to exactly this wallet. */
export async function checkPairingStatus(session: WalletSession): Promise<boolean> {
  const provider = getInjectedProvider();
  if (!provider) return false;
  try {
    const { paired } = await provider.pairStatus({
      address: session.accountId,
      network: session.network,
    });
    return paired;
  } catch {
    return false;
  }
}

export async function pairExtension(session: WalletSession): Promise<PairingResult> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("The Vellar extension is not installed in this browser");
  if (!session.keyId) {
    throw new Error("This session has no passkey credential id — sign out and back in, then retry");
  }

  const config = walletConfig();
  // 1. Extension consent (its popup shows origin + wallet) → device public key.
  //    The extension needs rpcUrl/keyId/wasm hash to attach the kit for signing.
  const { devicePublicKeyHex } = await provider.pair({
    address: session.accountId,
    network: session.network,
    rpcUrl: config.rpcUrl,
    keyId: session.keyId,
    walletWasmHash: config.walletWasmHash,
  });

  // 2. Passkey consent: add the device key as an expiring on-chain signer.
  const runtime = await getWalletRuntime();
  if (session.keyId) await runtime.resume(session.keyId);
  const result = await runtime.addDeviceSigner(devicePublicKeyHex);
  rememberPairing(session.accountId, result);
  return result;
}
