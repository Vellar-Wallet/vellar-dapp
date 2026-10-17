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

// --- Extension <-> Web postMessage protocol schema versioning (#599) ---

export const MESSAGE_SCHEMA_VERSION = 1 as const;
export const EXTENSION_POST_MESSAGE_CHANNEL = "vela-provider" as const;

export type ExtensionMessageKind = "request" | "response";

export interface ExtensionPostMessage<TPayload = unknown> {
  schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  channel: typeof EXTENSION_POST_MESSAGE_CHANNEL;
  kind: ExtensionMessageKind;
  id: string;
  payload: TPayload;
}

export class UnsupportedMessageSchemaError extends Error {
  readonly receivedVersion: unknown;
  readonly expectedVersion = MESSAGE_SCHEMA_VERSION;

  constructor(receivedVersion: unknown) {
    const detail =
      receivedVersion === undefined
        ? "missing schemaVersion"
        : `unsupported schemaVersion "${String(receivedVersion)}"`;
    super(
      `Rejected extension postMessage: ${detail} (expected schemaVersion ${MESSAGE_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedMessageSchemaError";
    this.receivedVersion = receivedVersion;
  }
}

/**
 * Builds a schema-versioned outgoing extension-web postMessage envelope (`schemaVersion: 1`).
 */
export function createExtensionPostMessage<TPayload>(input: {
  kind: ExtensionMessageKind;
  id: string;
  payload: TPayload;
}): ExtensionPostMessage<TPayload> {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    channel: EXTENSION_POST_MESSAGE_CHANNEL,
    kind: input.kind,
    id: input.id,
    payload: input.payload,
  };
}

/**
 * Validates an incoming extension-web postMessage envelope (#599).
 * Rejects messages with a missing or unsupported `schemaVersion` with a clear
 * error log and throws `UnsupportedMessageSchemaError`.
 */
export function validateIncomingExtensionMessage<TPayload = unknown>(
  raw: unknown,
): ExtensionPostMessage<TPayload> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Rejected extension postMessage: message must be a non-null object");
  }

  const candidate = raw as Record<string, unknown>;
  if (!("schemaVersion" in candidate) || candidate.schemaVersion === undefined) {
    const err = new UnsupportedMessageSchemaError(undefined);
    console.error(`[messages] ${err.message}`);
    throw err;
  }

  if (candidate.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    const err = new UnsupportedMessageSchemaError(candidate.schemaVersion);
    console.error(`[messages] ${err.message}`);
    throw err;
  }

  if (candidate.channel !== EXTENSION_POST_MESSAGE_CHANNEL) {
    throw new Error(
      `Rejected extension postMessage: invalid channel "${String(candidate.channel)}"`,
    );
  }

  if (candidate.kind !== "request" && candidate.kind !== "response") {
    throw new Error(`Rejected extension postMessage: invalid kind "${String(candidate.kind)}"`);
  }

  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw new Error("Rejected extension postMessage: message id must be a non-empty string");
  }

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    channel: EXTENSION_POST_MESSAGE_CHANNEL,
    kind: candidate.kind,
    id: candidate.id,
    payload: candidate.payload as TPayload,
  };
}

/**
 * Safe parser wrapper around `validateIncomingExtensionMessage` that logs and returns
 * `undefined` when an incoming message has a missing/unsupported `schemaVersion` or is malformed.
 */
export function parseIncomingExtensionMessage<TPayload = unknown>(
  raw: unknown,
): ExtensionPostMessage<TPayload> | undefined {
  try {
    return validateIncomingExtensionMessage<TPayload>(raw);
  } catch {
    return undefined;
  }
}

