import { normalizePasskeyError, type PasskeyErrorCode } from "@vellar/passkey";
import { WalletApiError } from "./http-backend";

// One place mapping failures to user-facing copy (DRY across onboarding,
// signing, and future extension surfaces).

const passkeyMessages: Record<PasskeyErrorCode, string> = {
  cancelled: "The passkey prompt was dismissed. Try again when you're ready.",
  "credential-exists":
    "A passkey for Vellar already exists on this device. Try signing in instead.",
  unsupported: "This browser doesn't support the required passkey features.",
  security: "Passkeys are blocked in this context. Make sure you're on the official Vellar site.",
  aborted: "The passkey request was interrupted. Try again.",
  unknown: "Something went wrong with the passkey prompt. Try again.",
};

// passkey-kit PasskeyKitErrorCode values (numeric; the enum itself is
// browser-only, so it isn't imported here).
const KIT_WALLET_NOT_FOUND = 2003;
const KIT_WALLET_OWNERSHIP_MISMATCH = 2004;

const kitMessages: Record<number, string> = {
  [KIT_WALLET_NOT_FOUND]:
    "No Vellar wallet was found for this passkey on this network. Create a wallet instead.",
  [KIT_WALLET_OWNERSHIP_MISMATCH]:
    "This passkey isn't a signer on the wallet it points to, so it can't sign in.",
};

function kitCode(err: unknown): number | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "number" ? code : undefined;
}

/**
 * The browser's own WebAuthn error when passkey-kit wrapped it. The kit turns
 * every failed ceremony (including the user dismissing the prompt) into a
 * `WebAuthnError` carrying the DOMException as `cause`; classify that cause,
 * or a cancel reads as "something went wrong".
 */
export function passkeyCause(err: unknown): unknown {
  if (kitCode(err) === undefined) return err;
  const cause = (err as { cause?: unknown }).cause;
  return cause ?? err;
}

export function walletErrorMessage(err: unknown): string {
  if (err instanceof WalletApiError) return err.message;
  const kit = kitCode(err);
  if (kit !== undefined && kitMessages[kit]) return kitMessages[kit];
  return passkeyMessages[normalizePasskeyError(passkeyCause(err)).code];
}
