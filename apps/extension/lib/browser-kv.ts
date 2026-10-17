import { browser } from "wxt/browser";
import type { KeyValueStore } from "./state";

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Typed error thrown when `browser.storage.local.set` fails due to browser
 * extension storage quota exhaustion (`QuotaExceededError` / `QUOTA_BYTES`).
 */
export class StorageQuotaExceededError extends Error {
  readonly code = "storage_quota_exceeded" as const;
  readonly key: string;
  override readonly cause: unknown;

  constructor(key: string, cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
    super(`Browser storage quota exceeded while writing key "${key}"${detail}`);
    this.name = "StorageQuotaExceededError";
    this.key = key;
    this.cause = cause;
  }
}

const QUOTA_ERROR_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);

const QUOTA_MESSAGE_PATTERN = /quota[_\s-]*exceeded|quota_bytes/i;

export function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof StorageQuotaExceededError) return true;
  if (typeof err === "string") {
    return QUOTA_MESSAGE_PATTERN.test(err);
  }
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && QUOTA_ERROR_NAMES.has(name)) {
      return true;
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && QUOTA_MESSAGE_PATTERN.test(message)) {
      return true;
    }
  }
  return false;
}

export function createBrowserKv(
  getStorageArea: () => StorageAreaLike = () => browser.storage.local,
): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await getStorageArea().get(key);
      return result[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      try {
        await getStorageArea().set({ [key]: value });
      } catch (err) {
        if (isQuotaExceededError(err)) {
          throw new StorageQuotaExceededError(key, err);
        }
        throw err;
      }
    },
  };
}

/** browser.storage.local-backed KV (production implementation of the state seam). */
export const browserKv: KeyValueStore = createBrowserKv();
