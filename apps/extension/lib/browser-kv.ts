import { browser } from "wxt/browser";
import type { KeyValueStore } from "./state";

/**
 * Thrown when `browser.storage.local.set` rejects because the extension's
 * storage quota is exhausted (#584). Distinguishable from a generic storage
 * error (corrupted store, permission revoked, disconnected extension
 * context) so callers can react specifically, e.g. by pruning old data
 * instead of surfacing a one-size-fits-all failure to the user.
 *
 * `browser.storage.local.set` never writes only part of a value: the whole
 * call either lands or rejects, so a quota-exceeded (or any other) rejected
 * write leaves the previously-stored value under `key` untouched — a
 * subsequent `get` never observes a partially-written value.
 */
export class StorageQuotaExceededError extends Error {
  readonly code = "storage_quota_exceeded";
  constructor(key: string, cause: unknown) {
    super(`Storage quota exceeded while writing key "${key}".`);
    this.name = "StorageQuotaExceededError";
    this.cause = cause;
  }
}

/**
 * Chrome rejects with an Error whose message contains "QUOTA_BYTES" (or, on
 * the sync storage area, "QUOTA_BYTES_PER_ITEM"); Firefox/WebExtension
 * polyfills reject with a DOMException named "QuotaExceededError". Checking
 * both keeps this working across the browsers `wxt/browser` targets.
 */
function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return true;
  if (error instanceof Error && /QUOTA_BYTES/.test(error.message)) return true;
  return false;
}

/** browser.storage.local-backed KV (production implementation of the state seam). */
export const browserKv: KeyValueStore = {
  async get(key) {
    const result = await browser.storage.local.get(key);
    return result[key];
  },
  async set(key, value) {
    try {
      await browser.storage.local.set({ [key]: value });
    } catch (cause) {
      if (isQuotaExceededError(cause)) {
        throw new StorageQuotaExceededError(key, cause);
      }
      throw cause;
    }
  },
};
