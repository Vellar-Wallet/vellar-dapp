// Normalizes WebAuthn failures into stable codes the UI can message on,
// instead of every surface interpreting DOMException names itself (DRY).

export type PasskeyErrorCode =
  | "cancelled" // user dismissed the prompt or it timed out (NotAllowedError)
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
