/**
 * Input sanitization helpers for dApp connection requests and metadata payloads.
 * Prevents HTML/script injection attacks and normalizes malformed payload fields
 * before displaying them in the extension UI.
 */

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ORIGIN_LENGTH = 200;
export const MAX_MEMO_LENGTH = 28;

/**
 * Matches non-printable ASCII C0/C1 control characters, Unicode zero-width
 * format characters, and Unicode bidirectional (Bidi) override/isolate
 * characters (Trojan Source / visual spoofing vectors: LRE, RLE, PDF, LRO,
 * RLO, LRI, RLI, FSI, PDI, LRM, RLM, ALM).
 */
const CONTROL_AND_BIDI_PATTERN =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Strips non-printable C0/C1 control characters, zero-width characters, and
 * Unicode bidirectional text override/isolate characters from `str`.
 */
export function stripControlAndBidiChars(str: string): string {
  return str.replace(CONTROL_AND_BIDI_PATTERN, "");
}

/**
 * Escape HTML special characters to prevent script injection when rendered in the UI.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
}

/**
 * Remove dangerous URI schemes like javascript: or data: from URLs.
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url || typeof url !== "string") return "";
  const trimmed = stripControlAndBidiChars(url).trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return "";
  }
  return escapeHtml(trimmed);
}

/**
 * Sanitize a plain text string field (name, title, description, etc.).
 * Strips HTML tags, C0/C1 control characters, bidirectional text overrides,
 * and enforces length limits.
 */
export function sanitizeString(input: unknown, maxLength: number = MAX_DESCRIPTION_LENGTH): string {
  if (input === null || input === undefined) return "";
  const str = String(input);
  // Remove C0/C1 control characters and Unicode bidi overrides (except space, tab, newline)
  const cleaned = stripControlAndBidiChars(str);
  // Strip tags and escape remaining HTML
  const stripped = cleaned.replace(/<[^>]*>?/gm, "");
  const escaped = escapeHtml(stripped.trim());
  return escaped.slice(0, maxLength);
}

/**
 * Sanitize a dApp-supplied transaction memo field before rendering in the
 * approval screen.
 *
 * In addition to stripping C0/C1 control characters, zero-width characters,
 * Unicode bidirectional overrides (`U+202A`–`U+202E`, `U+2066`–`U+2069`), and
 * HTML tags, collapses embedded newlines/tabs/line-separators into single
 * spaces so a crafted memo cannot forge fake multi-line UI rows on the
 * approval screen.
 */
export function sanitizeMemo(input: unknown, maxLength: number = MAX_MEMO_LENGTH): string {
  if (input === null || input === undefined) return "";
  const str = String(input);
  const withoutControls = stripControlAndBidiChars(str).replace(/[\r\n\t\u2028\u2029]+/g, " ");
  const stripped = withoutControls.replace(/<[^>]*>?/gm, "");
  const escaped = escapeHtml(stripped.trim());
  return escaped.slice(0, maxLength);
}

export interface DAppMetadataInput {
  name?: unknown;
  description?: unknown;
  iconUrl?: unknown;
  origin?: unknown;
}

export interface SanitizedDAppMetadata {
  name: string;
  description: string;
  iconUrl: string;
  origin: string;
}

/**
 * Sanitize connection request metadata payload from a dApp.
 */
export function sanitizeDAppMetadata(payload: DAppMetadataInput): SanitizedDAppMetadata {
  return {
    name: sanitizeString(payload.name, MAX_NAME_LENGTH) || "Unknown dApp",
    description: sanitizeString(payload.description, MAX_DESCRIPTION_LENGTH),
    iconUrl: sanitizeUrl(typeof payload.iconUrl === "string" ? payload.iconUrl : undefined),
    origin: sanitizeString(payload.origin, MAX_ORIGIN_LENGTH),
  };
}
