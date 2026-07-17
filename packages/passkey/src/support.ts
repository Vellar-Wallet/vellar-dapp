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
