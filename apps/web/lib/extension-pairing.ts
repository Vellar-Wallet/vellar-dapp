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

/** Default origins allowed to initiate pairing. Fail-closed: anything else is refused. */
export const PAIRING_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://app.vellar.xyz",
  "https://vellar.xyz",
];

// The allowlist in force *right now*. An origin can be removed while a session
// that started under it is still open (#849), so every pairing-dependent action
// re-reads this rather than trusting an "allowed at session start" decision.
let currentAllowedOrigins: readonly string[] = PAIRING_ALLOWED_ORIGINS;

/** The pairing allowlist currently in force. */
export function getPairingAllowedOrigins(): readonly string[] {
  return currentAllowedOrigins;
}

/** Replaces the pairing allowlist (e.g. an origin revoked at runtime). Takes
 * effect for the very next pairing-dependent action, including ones belonging
 * to sessions that are already open. Entries are normalized; malformed entries
 * are dropped (fail-closed) rather than widening the list. */
export function setPairingAllowedOrigins(origins: readonly string[]): void {
  currentAllowedOrigins = Object.freeze(
    origins.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== undefined),
  );
}

/** Restores the default allowlist (tests, config reset). */
export function resetPairingAllowedOrigins(): void {
  currentAllowedOrigins = PAIRING_ALLOWED_ORIGINS;
}

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
  return normalized !== undefined && currentAllowedOrigins.includes(normalized);
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
  // Re-checked on every call (#849): an origin removed from the allowlist after
  // this session started must not keep reading pairing state. Fail-closed to
  // "not paired" without contacting the extension.
  if (!isPairingOriginAllowed(window.location.origin)) return false;
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
  //    The extension prompt above can sit open for a long time; if the origin
  //    was removed from the allowlist meanwhile, the gate decision taken at the
  //    top of this call is stale. Re-check against the CURRENT allowlist before
  //    the on-chain signer is added (#849).
  assertPairingOriginAllowed(window.location.origin);
  const runtime = await getWalletRuntime();
  if (session.keyId) await runtime.resume(session.keyId);
  assertPairingOriginAllowed(window.location.origin);
  const result = await runtime.addDeviceSigner(devicePublicKeyHex);
  rememberPairing(session.accountId, result);
  return result;
}
