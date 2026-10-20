import { normalizePasskeyError, PasskeyError } from "./errors";

// Browser compatibility helpers (technical-doc.md §5.1 notes: passkey support
// must be designed for browser compatibility). DI-shaped so it's testable and
// usable from both the web app and the extension.

export type PasskeySupport =
  { supported: true } | { supported: false; reason: "insecure-context" | "no-webauthn" };

export interface PasskeyEnvironment {
  isSecureContext: boolean;
  publicKeyCredential:
    { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } | undefined;
}

export function environmentFromWindow(win: Window & typeof globalThis): PasskeyEnvironment {
  return {
    isSecureContext: win.isSecureContext,
    publicKeyCredential: win.PublicKeyCredential,
  };
}

/** Synchronous gate: can this context attempt WebAuthn at all? */
export function detectPasskeySupport(env: PasskeyEnvironment): PasskeySupport {
  if (!env.isSecureContext) return { supported: false, reason: "insecure-context" };
  if (!env.publicKeyCredential) return { supported: false, reason: "no-webauthn" };
  return { supported: true };
}

/**
 * Async check for a user-verifying platform authenticator (Touch ID, Windows
 * Hello, ...). False when unsupported or when the browser check itself fails —
 * callers use this to prefer platform passkeys, not to hard-block.
 */
export async function hasPlatformAuthenticator(env: PasskeyEnvironment): Promise<boolean> {
  const check = env.publicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
  if (!check) return false;
  try {
    return await check.call(env.publicKeyCredential);
  } catch {
    return false;
  }
}

export interface CreatePasskeyCredentialOptions {
  /**
   * When true (default), verifies that a user-verifying platform authenticator
   * is available before invoking the WebAuthn ceremony, throwing a typed
   * `PasskeyError("no-authenticator", ...)` if none is reported.
   */
  requirePlatformAuthenticator?: boolean;
}

/**
 * Run a passkey credential-creation ceremony gated by browser WebAuthn feature
 * detection and authenticator availability checks:
 * 1. If the browser does not support WebAuthn at all (`publicKeyCredential` missing),
 *    throws a feature-detection `PasskeyError` with code `"no-webauthn"` (never a raw TypeError).
 * 2. If the browser is not in a secure context, throws `PasskeyError` with code `"security"`.
 * 3. If the browser reports no available platform authenticator (or the ceremony fails
 *    due to missing authenticator support), throws `PasskeyError` with code `"no-authenticator"`,
 *    clearly distinguished from user cancellation (`code: "cancelled"`).
 */
export async function createPasskeyCredential<T>(
  env: PasskeyEnvironment,
  createFn: () => Promise<T>,
  options: CreatePasskeyCredentialOptions = {},
): Promise<T> {
  const support = detectPasskeySupport(env);
  if (!support.supported) {
    if (support.reason === "no-webauthn") {
      throw new PasskeyError(
        "no-webauthn",
        "This browser does not support WebAuthn passkeys (PublicKeyCredential is unavailable).",
        undefined,
      );
    }
    throw new PasskeyError(
      "security",
      "Passkey creation requires a secure HTTPS context.",
      undefined,
    );
  }

  const requirePlatform = options.requirePlatformAuthenticator ?? true;
  if (requirePlatform) {
    const available = await hasPlatformAuthenticator(env);
    if (!available) {
      throw new PasskeyError(
        "no-authenticator",
        "No compatible passkey authenticator is available on this device.",
        undefined,
      );
    }
  }

  try {
    const credential = await createFn();
    if (credential === null || credential === undefined) {
      throw new PasskeyError(
        "no-authenticator",
        "No passkey credential was returned by the authenticator.",
        undefined,
      );
    }
    return credential;
  } catch (err) {
    throw normalizePasskeyError(err);
  }
}
