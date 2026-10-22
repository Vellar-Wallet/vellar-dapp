"use client";

import type { WalletSession } from "@vellar/types";
import { normalizeOrigin, type VelaProvider } from "@vellar/provider-sdk";
import { walletConfig } from "./config";
import { getWalletRuntime } from "./connector-factory";

// Web-to-extension pairing (technical-doc.md §7.2; docs/decisions.md device
// signer): ask the injected extension provider for a device public key, then
// add it as an expiring on-chain signer with the user's passkey.
//
// L3 (docs/security-audit.md): pairing is gated on a fail-closed web-app-origin
// allowlist. The extension enforces the same policy server-side
// (apps/extension/lib/pair-origins.ts); this client-side gate is defense in
// depth so a phished copy of the app never even reaches the extension prompt.

/** Origins allowed to initiate pairing. Fail-closed: anything else is refused. */
export const PAIRING_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://app.vellar.xyz",
  "https://vellar.xyz",
];

export class PairingOriginError extends Error {
  readonly code = "pairing_origin_not_allowed";
  constructor(origin: string) {
    super(`Pairing is not permitted from this origin: ${origin}`);
    this.name = "PairingOriginError";
  }
}

/** True when `origin` may initiate pairing (L5: a single trailing dot on the
 * host is the same FQDN and is normalized before the allowlist check). */
export function isPairingOriginAllowed(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized !== undefined && PAIRING_ALLOWED_ORIGINS.includes(normalized);
}

/** Rejects a pairing attempt from an origin not on the allowlist, with a
 * logged reason. Fail-closed: a malformed origin is refused too. */
export function assertPairingOriginAllowed(origin: string): void {
  if (isPairingOriginAllowed(origin)) return;
  console.warn(`[extension-pairing] rejected pairing request from origin ${origin}`);
  throw new PairingOriginError(origin);
}

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
  assertPairingOriginAllowed(window.location.origin);
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
