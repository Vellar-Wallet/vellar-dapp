import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  createMemoryDeviceKeyStore,
  devicePublicKeyHex,
  ensureDeviceKey,
  signWithDeviceKey,
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
