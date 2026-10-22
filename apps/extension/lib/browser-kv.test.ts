/**
 * Tests for browserKv's storage quota handling (#584).
 *
 * Covers:
 *  - happy path: set then get round-trips the value
 *  - a Chrome-style QUOTA_BYTES rejection surfaces as StorageQuotaExceededError
 *  - a Firefox-style QuotaExceededError DOMException also surfaces as
 *    StorageQuotaExceededError
 *  - a generic (non-quota) storage error is NOT reclassified as quota-exceeded
 *  - a read immediately after a failed write does not return partially-written
 *    data: the previously-stored value is unchanged
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const storageState = new Map<string, unknown>();
const setMock = vi.fn(async (items: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(items)) {
    storageState.set(key, value);
  }
});
const getMock = vi.fn(async (key: string) => {
  return storageState.has(key) ? { [key]: storageState.get(key) } : {};
});

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: (key: string) => getMock(key),
        set: (items: Record<string, unknown>) => setMock(items),
      },
    },
  },
}));

// Imported after the mock so browserKv closes over the mocked browser.
const { browserKv, StorageQuotaExceededError } = await import("./browser-kv");

beforeEach(() => {
  storageState.clear();
  setMock.mockClear();
  getMock.mockClear();
  setMock.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      storageState.set(key, value);
    }
  });
});

describe("browserKv", () => {
  it("round-trips a value through set then get (happy path)", async () => {
    await browserKv.set("pairing", { origin: "https://dapp.example" });
    const result = await browserKv.get("pairing");
    expect(result).toEqual({ origin: "https://dapp.example" });
  });

  it("surfaces a Chrome-style QUOTA_BYTES rejection as StorageQuotaExceededError", async () => {
    setMock.mockImplementationOnce(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    });

    await expect(browserKv.set("pairing", { origin: "https://dapp.example" })).rejects.toThrow(
      StorageQuotaExceededError,
    );
  });

  it("surfaces a Firefox-style QuotaExceededError DOMException as StorageQuotaExceededError", async () => {
    setMock.mockImplementationOnce(async () => {
      throw new DOMException("The storage quota has been exceeded.", "QuotaExceededError");
    });

    await expect(browserKv.set("pairing", { origin: "https://dapp.example" })).rejects.toThrow(
      StorageQuotaExceededError,
    );
  });

  it("does not reclassify a generic storage error as quota-exceeded", async () => {
    setMock.mockImplementationOnce(async () => {
      throw new Error("Extension context invalidated.");
    });

    const failure = await browserKv
      .set("pairing", { origin: "https://dapp.example" })
      .catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(StorageQuotaExceededError);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Extension context invalidated.");
  });

  it("the quota-exceeded error is distinguishable from a generic error by instanceof and code", async () => {
    setMock.mockImplementationOnce(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    });

    try {
      await browserKv.set("pairing", { origin: "https://dapp.example" });
      throw new Error("expected set() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageQuotaExceededError);
      expect((error as InstanceType<typeof StorageQuotaExceededError>).code).toBe(
        "storage_quota_exceeded",
      );
    }
  });

  it("a read immediately after a failed write does not return partially-written data", async () => {
    // Establish a known-good prior value.
    await browserKv.set("pairing", { origin: "https://known-good.example" });

    setMock.mockImplementationOnce(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    });

    await expect(
      browserKv.set("pairing", { origin: "https://attacker-cannot-see-this.example" }),
    ).rejects.toThrow(StorageQuotaExceededError);

    // The failed write must not have landed, even partially: the read
    // returns exactly the last successfully-written value.
    const result = await browserKv.get("pairing");
    expect(result).toEqual({ origin: "https://known-good.example" });
  });
});
