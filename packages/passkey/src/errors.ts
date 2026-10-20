// Normalizes WebAuthn failures into stable codes the UI can message on,
// instead of every surface interpreting DOMException names itself (DRY).

export type PasskeyErrorCode =
  | "cancelled" // user dismissed the prompt or it timed out (NotAllowedError)
  | "no-authenticator" // browser/device reports no compatible authenticator available
  | "no-webauthn" // browser does not support WebAuthn (feature-detection failure)
  | "credential-exists" // registration hit an already-registered credential (InvalidStateError)
  | "unsupported" // authenticator/algorithm not supported (NotSupportedError)
  | "security" // RP ID / origin mismatch or insecure context (SecurityError)
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
  ConstraintError: "no-authenticator",
  InvalidStateError: "credential-exists",
  NotSupportedError: "unsupported",
  SecurityError: "security",
  AbortError: "aborted",
};

const NO_AUTHENTICATOR_MESSAGE_PATTERN =
  /no\s+(?:available\s+|compatible\s+|platform\s+)?authenticator|authenticator\s+(?:is\s+)?not\s+available|requested\s+authenticator\s+attachment/i;

const NO_WEBAUTHN_MESSAGE_PATTERN =
  /webauthn\s+is\s+not\s+supported|publickeycredential\s+is\s+not\s+(?:defined|supported|available)/i;

const DEFAULT_CODE_MESSAGES: Record<PasskeyErrorCode, string> = {
  cancelled: "Passkey request was cancelled by the user or timed out.",
  "no-authenticator": "No compatible passkey authenticator is available on this device.",
  "no-webauthn": "This browser does not support WebAuthn passkeys.",
  "credential-exists":
    "A passkey credential already exists for this account on this authenticator.",
  unsupported: "The authenticator or requested cryptographic algorithm is not supported.",
  security: "Passkey operation was blocked by browser security policy or an insecure origin.",
  aborted: "Passkey operation was aborted.",
  unknown: "Passkey operation failed (unknown).",
};

export function normalizePasskeyError(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name =
    typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;
  const rawMessage = err instanceof Error && err.message ? err.message : "";

  let code: PasskeyErrorCode;
  if (NO_WEBAUTHN_MESSAGE_PATTERN.test(rawMessage)) {
    code = "no-webauthn";
  } else if (
    name === "ConstraintError" ||
    ((name === "NotAllowedError" || name === "NotSupportedError" || !name) &&
      NO_AUTHENTICATOR_MESSAGE_PATTERN.test(rawMessage))
  ) {
    code = "no-authenticator";
  } else {
    code = (name && domErrorNameToCode[name]) || "unknown";
  }

  const message =
    rawMessage && rawMessage !== "webauthn failed"
      ? rawMessage
      : code === "unknown"
        ? `Passkey operation failed (${code})`
        : DEFAULT_CODE_MESSAGES[code];
  return new PasskeyError(code, message, err);
}

/** True when the failure is the user changing their mind — not an app or device capability defect. */
export function isUserCancellation(err: unknown): boolean {
  const code = err instanceof PasskeyError ? err.code : normalizePasskeyError(err).code;
  return code === "cancelled" || code === "aborted";
}

/**
 * True when credential creation failed because no compatible authenticator or
 * WebAuthn implementation is available (distinct from user cancellation).
 */
export function isNoAuthenticatorError(err: unknown): boolean {
  const code = err instanceof PasskeyError ? err.code : normalizePasskeyError(err).code;
  return code === "no-authenticator" || code === "unsupported" || code === "no-webauthn";
}
