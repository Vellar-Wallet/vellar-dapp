import { normalizePasskeyError, type PasskeyErrorCode } from "@vela/passkey";
import { WalletApiError } from "./http-backend";

// One place mapping failures to user-facing copy (DRY across onboarding,
// signing, and future extension surfaces).

const passkeyMessages: Record<PasskeyErrorCode, string> = {
  cancelled: "The passkey prompt was dismissed. Try again when you're ready.",
  "credential-exists": "A passkey for VELA already exists on this device. Try signing in instead.",
  unsupported: "This browser doesn't support the required passkey features.",
  security: "Passkeys are blocked in this context. Make sure you're on the official VELA site.",
  aborted: "The passkey request was interrupted. Try again.",
  unknown: "Something went wrong with the passkey prompt. Try again.",
};

export function walletErrorMessage(err: unknown): string {
  if (err instanceof WalletApiError) return err.message;
  return passkeyMessages[normalizePasskeyError(err).code];
}
