// Normalizes WebAuthn failures into stable codes the UI can message on,
// instead of every surface interpreting DOMException names itself (DRY).

export type PasskeyErrorCode =
  | "cancelled" // user dismissed the prompt or it timed out (NotAllowedError)
  | "no-authenticator" // no available authenticator on the device (NotAllowedError without user interaction)
  | "credential-exists" // registration hit an already-registered credential (InvalidStateError)
  | "unsupported" // authenticator/algorithm not supported (NotSupportedError)
  | "security" // RP ID / origin mismatch (SecurityError)
  | "aborted" // programmatically aborted (AbortError)
  | "unknown";

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  override readonly cause: unknown;

  constructor(code: PasskeyErrorCode, message: string, cause: unknown) {
    super(message);
    this.name = "PasskeyError";
    this.code = code;
    this.cause = cause;
  }
}

const domErrorNameToCode: Record<string, PasskeyErrorCode> = {
  NotAllowedError: "cancelled",
  InvalidStateError: "credential-exists",
  NotSupportedError: "unsupported",
  SecurityError: "security",
  AbortError: "aborted",
};

export function normalizePasskeyError(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name =
    typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;
  const code = (name && domErrorNameToCode[name]) || "unknown";
  const message =
    err instanceof Error && err.message ? err.message : `Passkey operation failed (${code})`;
  return new PasskeyError(code, message, err);
}

/** True when the failure is the user changing their mind — not an app defect. */
export function isUserCancellation(err: unknown): boolean {
  const code = err instanceof PasskeyError ? err.code : normalizePasskeyError(err).code;
  return code === "cancelled" || code === "aborted";
}

/** Default messages keyed by error code, so the two failure modes that both
 * surface as NotAllowedError (user-cancel vs no-authenticator) produce
 * distinct messages the UI can render. */
export const PASSKEY_ERROR_MESSAGES: Record<PasskeyErrorCode, string> = {
  cancelled: "Passkey registration was cancelled.",
  "no-authenticator": "No passkey authenticator is available on this device.",
  "credential-exists": "A passkey credential already exists for this account.",
  unsupported: "This authenticator or algorithm is not supported.",
  security: "Security error: RP ID or origin mismatch.",
  aborted: "Passkey registration was aborted.",
  unknown: "Passkey operation failed.",
};

/**
 * Map a raw WebAuthn error to a PasskeyError with a stable code and a
 * human-readable message that distinguishes user-cancel from
 * no-authenticator-available (issue #551).
 *
 * When `hadAuthenticator` is true, NotAllowedError is treated as user
 * cancellation. When false, it is treated as no-authenticator-available.
 */
export function toPasskeyError(err: unknown, hadAuthenticator: boolean): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name =
    typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;

  if (name === "NotAllowedError" && !hadAuthenticator) {
    return new PasskeyError("no-authenticator", PASSKEY_ERROR_MESSAGES["no-authenticator"], err);
  }

  const code = (name && domErrorNameToCode[name]) || "unknown";
  return new PasskeyError(code, PASSKEY_ERROR_MESSAGES[code], err);
}
