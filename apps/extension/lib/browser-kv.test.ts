import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_GRANT_CAPABILITIES } from "@vellar/provider-sdk";
import { addGrant, loadState, setPairedWallet } from "./state";

const mockStorageArea = vi.hoisted(() => ({
  get: vi.fn<
    (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>
  >(),
  set: vi.fn<(items: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: mockStorageArea,
    },
  },
}));

import {
  browserKv,
  createBrowserKv,
  isQuotaExceededError,
  StorageQuotaExceededError,
  type StorageAreaLike,
} from "./browser-kv";

/**
 * In-memory storage area enforcing a strict byte-quota ceiling.
 * Rejects writes that would exceed `maxBytes` without mutating existing keys.
 */
function createQuotaLimitedStorageArea(maxBytes: number): StorageAreaLike {
  const store = new Map<string, string>();

  function totalBytes(candidateUpdates: Record<string, unknown>): number {
    const next = new Map(store);
    for (const [k, v] of Object.entries(candidateUpdates)) {
      next.set(k, JSON.stringify(v));
    }
    let bytes = 0;
    for (const [k, serialized] of next) {
      bytes += k.length + serialized.length;
    }
    return bytes;
  }

  return {
    async get(keys) {
      if (typeof keys === "string") {
        const raw = store.get(keys);
        return raw !== undefined ? { [keys]: JSON.parse(raw) } : {};
      }
      const out: Record<string, unknown> = {};
      for (const [k, raw] of store) {
        out[k] = JSON.parse(raw);
      }
      return out;
    },
    async set(items) {
      if (totalBytes(items) > maxBytes) {
        const err = new Error("QUOTA_BYTES quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      }
      for (const [k, v] of Object.entries(items)) {
        store.set(k, JSON.stringify(v));
      }
    },
  };
}

describe("browserKv storage quota exceeded handling (#584)", () => {
  beforeEach(() => {
    mockStorageArea.get.mockReset();
    mockStorageArea.set.mockReset();
  });

  it("throws StorageQuotaExceededError when browser.storage.local.set rejects with QUOTA_BYTES", async () => {
    const chromeQuotaErr = new Error("QUOTA_BYTES quota exceeded");
    mockStorageArea.set.mockRejectedValueOnce(chromeQuotaErr);

    const writePromise = browserKv.set("vela:state:v1", { grants: [] });
    await expect(writePromise).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await expect(writePromise).rejects.toMatchObject({
      name: "StorageQuotaExceededError",
      code: "storage_quota_exceeded",
      key: "vela:state:v1",
      cause: chromeQuotaErr,
    });
  });

  it("recognizes DOM QuotaExceededError and NS_ERROR_DOM_QUOTA_REACHED", async () => {
    const domQuotaErr = new Error("The quota has been exceeded.");
    domQuotaErr.name = "QuotaExceededError";
    mockStorageArea.set.mockRejectedValueOnce(domQuotaErr);

    await expect(browserKv.set("vela:key", "payload")).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    );

    const ffQuotaErr = { name: "NS_ERROR_DOM_QUOTA_REACHED", message: "Storage full" };
    expect(isQuotaExceededError(ffQuotaErr)).toBe(true);
  });

  it("rethrows non-quota storage errors unchanged", async () => {
    const genericErr = new Error("Extension context invalidated");
    mockStorageArea.set.mockRejectedValueOnce(genericErr);

    await expect(browserKv.set("vela:state:v1", {})).rejects.toBe(genericErr);
    expect(isQuotaExceededError(genericErr)).toBe(false);
  });

  it("preserves previously committed state when a subsequent write exceeds storage quota", async () => {
    // Allow enough bytes for initial pairedWallet + 1 grant, but not a huge burst of grants.
    const area = createQuotaLimitedStorageArea(600);
    const kv = createBrowserKv(() => area);

    const pairedWallet = {
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      network: "testnet" as const,
      rpcUrl: "https://soroban-testnet.stellar.org",
      keyId: "cred-1",
      walletWasmHash: "ab".repeat(32),
      webAppOrigin: "https://app.vellar.dev",
    };

    await setPairedWallet(kv, pairedWallet);
    await addGrant(kv, {
      origin: "https://first-dapp.example",
      accountId: pairedWallet.address,
      network: "testnet",
      capabilities: [...CONNECT_GRANT_CAPABILITIES],
      grantedAt: "2026-03-30T00:00:00.000Z",
    });

    // Attempting to write an oversized grant fails with StorageQuotaExceededError.
    await expect(
      addGrant(kv, {
        origin: `https://${"oversized-subdomain.".repeat(15)}example.com`,
        accountId: pairedWallet.address,
        network: "testnet",
        capabilities: [...CONNECT_GRANT_CAPABILITIES],
        grantedAt: "2026-03-30T00:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);

    // Existing paired wallet and first grant must remain intact and uncorrupted.
    const stateAfterFailedWrite = await loadState(kv);
    expect(stateAfterFailedWrite.pairedWallet).toEqual(pairedWallet);
    expect(stateAfterFailedWrite.grants).toHaveLength(1);
    expect(stateAfterFailedWrite.grants[0]?.origin).toBe("https://first-dapp.example");
  });
});
