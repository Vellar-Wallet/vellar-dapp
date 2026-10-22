import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  checkDeviceKeyStatus,
  createMemoryDeviceKeyStore,
  devicePublicKeyHex,
  ensureDeviceKey,
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

// #581: the popup must tell a genuine load failure (corrupted storage, quota,
// browser storage wiped) apart from the normal first-run "nothing stored
// yet" state, and apart from a value that loaded but doesn't look like a
// valid key pair — each needs different recovery copy in the popup.
describe("checkDeviceKeyStatus", () => {
  it("'missing' on first run (store.get resolves undefined)", async () => {
    const check = await checkDeviceKeyStatus(createMemoryDeviceKeyStore());
    expect(check).toEqual({ status: "missing" });
  });

  it("'ok' with the pair when a valid key is stored", async () => {
    const store = createMemoryDeviceKeyStore();
    const pair = await ensureDeviceKey(store);
    const check = await checkDeviceKeyStatus(store);
    expect(check.status).toBe("ok");
    expect(check.pair).toBe(pair);
  });

  it("'load_failed' when the store itself throws (corrupted storage/quota/wipe)", async () => {
    const brokenStore: DeviceKeyStore = {
      get: () => Promise.reject(new Error("IndexedDB is corrupted")),
      set: () => Promise.reject(new Error("unused")),
      clear: () => Promise.reject(new Error("unused")),
    };
    const check = await checkDeviceKeyStatus(brokenStore);
    expect(check).toEqual({ status: "load_failed" });
  });

  it("'invalid' when a value loads but fails the integrity check (wrong format)", async () => {
    const store: DeviceKeyStore = {
      get: () => Promise.resolve({ notAKeyPair: true } as unknown as CryptoKeyPair),
      set: async () => {},
      clear: async () => {},
    };
    const check = await checkDeviceKeyStatus(store);
    expect(check).toEqual({ status: "invalid" });
  });

  it("'invalid' when the stored private key is extractable (tampered/legacy shape)", async () => {
    const store = createMemoryDeviceKeyStore();
    const extractablePair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await store.set(extractablePair);
    const check = await checkDeviceKeyStatus(store);
    expect(check).toEqual({ status: "invalid" });
  });
});
