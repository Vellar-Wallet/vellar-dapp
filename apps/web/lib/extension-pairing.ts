"use client";

import type { WalletSession } from "@vellar/types";
import type { VelaProvider } from "@vellar/provider-sdk";
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

/** Default origins permitted to initiate web-to-extension pairing. */
export const DEFAULT_ALLOWED_PAIRING_ORIGINS: readonly string[] = [
  "https://app.vellar.xyz",
  "https://vellar.xyz",
  "http://localhost:3000",
  "http://localhost:5173",
];

export class DisallowedPairingOriginError extends Error {
  readonly code = "unauthorized" as const;
  readonly origin: string;
  readonly reason: string;

  constructor(origin: string, reason: string) {
    super(`Pairing rejected for origin "${origin}": ${reason}`);
    this.name = "DisallowedPairingOriginError";
    this.origin = origin;
    this.reason = reason;
  }
}

export interface PairingOriginValidationResult {
  allowed: boolean;
  normalizedOrigin?: string;
  reason?: string;
}

/**
 * Resolve the list of allowed pairing origins from `NEXT_PUBLIC_ALLOWED_PAIRING_ORIGINS`
 * (comma-separated) when configured, falling back to `DEFAULT_ALLOWED_PAIRING_ORIGINS`.
 */
export function resolveAllowedPairingOrigins(rawEnv?: string): readonly string[] {
  const source =
    rawEnv !== undefined
      ? rawEnv
      : typeof process !== "undefined"
        ? process.env?.NEXT_PUBLIC_ALLOWED_PAIRING_ORIGINS
        : undefined;
  if (!source || !source.trim()) {
    return DEFAULT_ALLOWED_PAIRING_ORIGINS;
  }
  const parsed = source
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_PAIRING_ORIGINS;
}

/**
 * Strictly validate a candidate origin against the pairing origin allowlist.
 * Rejects malformed URLs, non-http(s) schemes, paths/queries/credentials,
 * trailing-dot FQDN variants (`https://app.vellar.xyz.`), and unapproved
 * subdomains (`https://sub.app.vellar.xyz`).
 */
export function validatePairingOrigin(
  rawOrigin: string,
  allowedOrigins: readonly string[] = resolveAllowedPairingOrigins(),
): PairingOriginValidationResult {
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed === "null") {
    return { allowed: false, reason: "Origin is empty or opaque ('null')" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { allowed: false, reason: "Origin is not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      allowed: false,
      reason: `Unsupported protocol "${url.protocol}" (only https: and localhost http: are permitted)`,
    };
  }

  if (url.username || url.password) {
    return { allowed: false, reason: "Origin must not contain credentials" };
  }

  if (url.hostname.endsWith(".")) {
    return {
      allowed: false,
      reason: `Trailing-dot hostname variant "${url.hostname}" is not permitted`,
    };
  }

  if (url.origin.toLowerCase() !== trimmed.toLowerCase()) {
    return {
      allowed: false,
      reason: "Origin must be a bare scheme://host[:port] without path, query, or fragment",
    };
  }

  const normalizedCandidate = url.origin.toLowerCase();
  const normalizedAllowlist = allowedOrigins.map((o) => o.trim().toLowerCase());

  if (normalizedAllowlist.includes(normalizedCandidate)) {
    return { allowed: true, normalizedOrigin: url.origin };
  }

  // Provide specific diagnostic reasons for near-miss origins (subdomains, scheme/port mismatch).
  for (const allowedEntry of normalizedAllowlist) {
    try {
      const allowedUrl = new URL(allowedEntry);
      if (
        url.hostname.toLowerCase() !== allowedUrl.hostname.toLowerCase() &&
        url.hostname.toLowerCase().endsWith(`.${allowedUrl.hostname.toLowerCase()}`)
      ) {
        return {
          allowed: false,
          reason: `Subdomain "${url.hostname}" is not permitted (only exact host "${allowedUrl.hostname}" is allowlisted)`,
        };
      }
      if (url.hostname.toLowerCase() === allowedUrl.hostname.toLowerCase()) {
        if (url.protocol !== allowedUrl.protocol) {
          return {
            allowed: false,
            reason: `Protocol mismatch "${url.protocol}" for host "${url.hostname}" (expected "${allowedUrl.protocol}")`,
          };
        }
        if (url.port !== allowedUrl.port) {
          return {
            allowed: false,
            reason: `Port mismatch "${url.port || "(default)"}" for host "${url.hostname}"`,
          };
        }
      }
    } catch {
      // Ignore malformed allowlist entry
    }
  }

  return {
    allowed: false,
    reason: `Origin "${url.origin}" is not in the pairing allowlist`,
  };
}

/**
 * Assert that `rawOrigin` is permitted to initiate extension pairing.
 * Logs a clear rejection reason and throws `DisallowedPairingOriginError` when disallowed.
 */
export function assertAllowedPairingOrigin(
  rawOrigin: string,
  allowedOrigins: readonly string[] = resolveAllowedPairingOrigins(),
): string {
  const check = validatePairingOrigin(rawOrigin, allowedOrigins);
  if (!check.allowed || !check.normalizedOrigin) {
    const reason = check.reason ?? "Origin is not in the pairing allowlist";
    console.error(
      `[Pairing] Rejected pairing request from disallowed origin "${rawOrigin}": ${reason}`,
    );
    throw new DisallowedPairingOriginError(rawOrigin, reason);
  }
  return check.normalizedOrigin;
}

export interface PairExtensionOptions {
  /** Override caller origin (defaults to `window.location.origin`). */
  origin?: string;
  /** Override allowed origins list (defaults to `resolveAllowedPairingOrigins()`). */
  allowedOrigins?: readonly string[];
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

export async function pairExtension(
  session: WalletSession,
  options?: PairExtensionOptions,
): Promise<PairingResult> {
  const currentOrigin =
    options?.origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  assertAllowedPairingOrigin(currentOrigin, options?.allowedOrigins);

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
