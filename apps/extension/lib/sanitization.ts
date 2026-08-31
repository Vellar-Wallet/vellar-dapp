/**
 * Input sanitization helpers for dApp connection requests and metadata payloads.
 * Prevents HTML/script injection attacks and normalizes malformed payload fields
 * before displaying them in the extension UI.
 */

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ORIGIN_LENGTH = 200;

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
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) {
    return "";
  }
  return escapeHtml(trimmed);
}

/**
 * Sanitize a plain text string field (name, title, description, etc.).
 * Strips HTML tags, control characters, and enforces length limits.
 */
export function sanitizeString(
  input: unknown,
  maxLength: number = MAX_DESCRIPTION_LENGTH,
): string {
  if (input === null || input === undefined) return "";
  const str = String(input);
  // Remove control characters (except space, tab, newline)
  const cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Strip tags and escape remaining HTML
  const stripped = cleaned.replace(/<[^>]*>?/gm, "");
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
