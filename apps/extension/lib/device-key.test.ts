import { describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  createMemoryDeviceKeyStore,
  DeviceKeyLoadError,
  devicePublicKeyHex,
  ensureDeviceKey,
  isValidDeviceKeyPair,
  loadDeviceKeyWithRecovery,
  recoverDeviceKey,
  signWithDeviceKey,
  type DeviceKeyStore,
} from "./device-key";

describe("ensureDeviceKey", () => {
  it("generates a NON-EXTRACTABLE Ed25519 key and persists it", async () => {
    const store = createMemoryDeviceKeyStore();
    const pair = await ensureDeviceKey(store);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.algorithm.name).toBe("Ed25519");
    await expect(store.get()).resolves.toBe(pair);
  });

  it("returns the same key on subsequent calls (stable device identity)", async () => {
    const store = createMemoryDeviceKeyStore();
    const first = await ensureDeviceKey(store);
    const second = await ensureDeviceKey(store);
    expect(second).toBe(first);
  });

  it("the private key cannot be exported", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore());
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  });
});

describe("devicePublicKeyHex", () => {
  it("exports 32 bytes of lowercase hex", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore());
    const hex = await devicePublicKeyHex(pair);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signWithDeviceKey", () => {
  it("produces a valid 64-byte Ed25519 signature over the payload", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore());
    const payload = new TextEncoder().encode("auth entry preimage");
    const signature = await signWithDeviceKey(pair, payload);
    expect(signature).toHaveLength(64);
    await expect(
      crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        signature as BufferSource,
        payload as BufferSource,
      ),
    ).resolves.toBe(true);
    // Tampered payload must not verify.
    await expect(
      crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        signature as BufferSource,
        new TextEncoder().encode("tampered") as BufferSource,
      ),
    ).resolves.toBe(false);
  });
});

describe("bytesToHex", () => {
  it("encodes deterministically with padding", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 255, 16]))).toBe("0001ff10");
  });
});

describe("device key load failure & recovery path (#581)", () => {
  it("distinguishes first-run absent key from a missing key when a wallet is already paired", async () => {
    const emptyStore = createMemoryDeviceKeyStore();

    const firstRun = await loadDeviceKeyWithRecovery(emptyStore, { isWalletPaired: false });
    expect(firstRun).toEqual({
      status: "absent",
      onboardingRequired: true,
    });

    const missingPaired = await loadDeviceKeyWithRecovery(emptyStore, { isWalletPaired: true });
    expect(missingPaired.status).toBe("recovery_required");
    if (missingPaired.status === "recovery_required") {
      expect(missingPaired.reason).toBe("missing_paired_device_key");
      expect(missingPaired.recoveryAction).toBe("re-pair");
      expect(missingPaired.error).toBeInstanceOf(DeviceKeyLoadError);
      expect(missingPaired.message).toMatch(/missing from browser storage/i);
    }
  });

  it("returns recovery_required when storage.get rejects on popup open", async () => {
    const idbFailure = new Error("IndexedDB backing store read failed");
    const failingStore: DeviceKeyStore = {
      get: vi.fn().mockRejectedValue(idbFailure),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const result = await loadDeviceKeyWithRecovery(failingStore, { isWalletPaired: true });
    expect(result.status).toBe("recovery_required");
    if (result.status === "recovery_required") {
      expect(result.reason).toBe("storage_read_error");
      expect(result.recoveryAction).toBe("re-pair");
      expect(result.error).toBeInstanceOf(DeviceKeyLoadError);
      expect(result.error.cause).toBe(idbFailure);
      expect(result.message).toMatch(/re-pair/i);
    }
  });

  it("detects a corrupted key record in storage and recovers a valid keypair via recoverDeviceKey", async () => {
    let rawSlot: unknown = { privateKey: "corrupted-blob", publicKey: null };
    const clearSpy = vi.fn(async () => {
      rawSlot = undefined;
    });
    const store: DeviceKeyStore = {
      get: async () => rawSlot as CryptoKeyPair | undefined,
      set: async (pair) => {
        rawSlot = pair;
      },
      clear: clearSpy,
    };

    expect(isValidDeviceKeyPair(rawSlot)).toBe(false);

    const beforeRecovery = await loadDeviceKeyWithRecovery(store, { isWalletPaired: true });
    expect(beforeRecovery.status).toBe("recovery_required");
    if (beforeRecovery.status === "recovery_required") {
      expect(beforeRecovery.reason).toBe("corrupted_key_record");
      expect(beforeRecovery.recoveryAction).toBe("re-pair");
    }

    // Trigger recovery path: clears corrupted record and generates a fresh Ed25519 keypair.
    const recoveredPair = await recoverDeviceKey(store);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(isValidDeviceKeyPair(recoveredPair)).toBe(true);

    const afterRecovery = await loadDeviceKeyWithRecovery(store, { isWalletPaired: true });
    expect(afterRecovery).toEqual({
      status: "ready",
      pair: recoveredPair,
    });
  });

  it("ensureDeviceKey self-heals when the stored key record is corrupted", async () => {
    let rawSlot: unknown = { invalid: true };
    const store: DeviceKeyStore = {
      get: async () => rawSlot as CryptoKeyPair | undefined,
      set: async (pair) => {
        rawSlot = pair;
      },
      clear: async () => {
        rawSlot = undefined;
      },
    };

    const pair = await ensureDeviceKey(store);
    expect(isValidDeviceKeyPair(pair)).toBe(true);
    expect(rawSlot).toBe(pair);
  });
});
