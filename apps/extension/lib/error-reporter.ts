/**
 * Error reporting service integration for the extension background worker (#302).
 * Captures uncaught and operational errors in the background worker and forwards
 * them to the centralized reporting endpoint along with extension version and browser metadata.
 */

export interface ErrorReportContext {
  extensionVersion: string;
  browserInfo: string;
  userAgent?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ErrorReportPayload {
  message: string;
  name: string;
  stack?: string;
  context: ErrorReportContext;
  timestamp: string;
}

export interface ErrorReportClient {
  send(payload: ErrorReportPayload): Promise<void>;
}

/**
 * Structured-field keys that, per WebAuthn's `PublicKeyCredential`/
 * `AuthenticatorAssertionResponse` shape, carry raw credential material: the
 * credential id itself, and the signed assertion's authenticator data,
 * client data, signature, and user handle (#699). A key match is
 * case-insensitive and matches on a substring, so a nested/renamed field
 * (e.g. `assertionResponse.clientDataJSON`, `credential.rawId`) is still
 * caught without needing to know the exact shape a future caller passes.
 */
const CREDENTIAL_FIELD_NAME_PATTERN =
  /rawid|credentialid|clientdatajson|attestationobject|authenticatordata|userhandle|publickey|signature/i;

/** What a caller sees in place of a redacted structured field. */
const REDACTED_PLACEHOLDER = "[redacted: passkey credential data]";

/**
 * A long run of base64url-alphabet characters is what a credential id,
 * signature, or any of the WebAuthn response buffers looks like once
 * stringified — including when embedded inside free-form text such as an
 * error MESSAGE, not just a structured field (#699's second requirement).
 * 32 characters is comfortably below the shortest credential-shaped value
 * these flows produce (session key ids, signatures, attestation blobs are
 * all well over 40), while being long enough that an ordinary word, UUID
 * dash-run, or short identifier never matches.
 */
const BASE64URL_RUN_PATTERN = /[A-Za-z0-9_-]{32,}/g;

function redactEmbeddedCredentialText(value: string): string {
  return value.replace(BASE64URL_RUN_PATTERN, "[redacted: possible credential data]");
}

/**
 * Recursively redacts anything in `value` that looks like raw passkey
 * credential material, by structured field name or by embedded
 * base64url-shaped text. Applied to every context value sent off-device —
 * this module has no allowlist of "safe" fields a caller might pass, so it
 * must actively strip the dangerous shapes rather than trust the caller.
 */
function redactCredentialData(value: unknown, keyHint?: string): unknown {
  if (keyHint && CREDENTIAL_FIELD_NAME_PATTERN.test(keyHint)) {
    return REDACTED_PLACEHOLDER;
  }
  if (typeof value === "string") {
    return redactEmbeddedCredentialText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialData(entry));
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    // A raw binary buffer (e.g. rawId, response.signature as bytes rather
    // than a stringified form) is exactly the credential material this
    // guards against, regardless of what key it's under.
    return REDACTED_PLACEHOLDER;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactCredentialData(v, k);
    }
    return out;
  }
  return value;
}

/** Default in-memory/console error reporting client fallback. */
export class DefaultErrorReportClient implements ErrorReportClient {
  private readonly reports: ErrorReportPayload[] = [];

  async send(payload: ErrorReportPayload): Promise<void> {
    this.reports.push(payload);
    console.error("[vellar-error-reporter]", payload.name, payload.message, payload.context);
  }

  getReports(): ErrorReportPayload[] {
    return [...this.reports];
  }
}

export interface ErrorReporterOptions {
  extensionVersion?: string;
  browserInfo?: string;
  client?: ErrorReportClient;
}

export class ErrorReporter {
  private readonly extensionVersion: string;
  private readonly browserInfo: string;
  private readonly client: ErrorReportClient;

  constructor(options: ErrorReporterOptions = {}) {
    this.extensionVersion =
      options.extensionVersion ??
      (typeof process !== "undefined" && process.env?.WXT_PUBLIC_VERSION
        ? process.env.WXT_PUBLIC_VERSION
        : "0.1.0");
    this.browserInfo =
      options.browserInfo ??
      (typeof navigator !== "undefined" ? navigator.userAgent : "BackgroundWorker/VellarExtension");
    this.client = options.client ?? new DefaultErrorReportClient();
  }

  async reportError(
    error: unknown,
    additionalContext: Record<string, unknown> = {},
  ): Promise<ErrorReportPayload> {
    const errObj = error instanceof Error ? error : new Error(String(error ?? "Unknown Error"));
    const rawMessage = errObj.message || "An unknown error occurred";
    const rawContext = {
      extensionVersion: this.extensionVersion,
      browserInfo: this.browserInfo,
      ...additionalContext,
    };
    // Redact both the structured context AND the message/stack text (#699):
    // credential data can arrive as a structured field in additionalContext,
    // or embedded as text inside an error's own message (e.g. a library that
    // interpolates the credential id into its thrown message).
    const payload: ErrorReportPayload = {
      name: errObj.name || "Error",
      message: redactEmbeddedCredentialText(rawMessage),
      stack: errObj.stack ? redactEmbeddedCredentialText(errObj.stack) : errObj.stack,
      context: redactCredentialData(rawContext) as ErrorReportContext,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.client.send(payload);
    } catch (sendErr) {
      console.error("Failed to deliver error report payload", sendErr);
    }

    return payload;
  }
}

/** Global background worker error reporter instance */
export const backgroundErrorReporter = new ErrorReporter();
