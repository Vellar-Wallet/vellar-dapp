import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  checkDeviceKeyStatus,
  createMemoryDeviceKeyStore,
  devicePublicKeyHex,
  ensureDeviceKey,
  signWithDeviceKey,
  type DeviceKeyStore,
  type StoredDeviceKey,
} from "./device-key";

const WALLET = "CWALLET";
const OTHER_WALLET = "COTHERWALLET";

describe("ensureDeviceKey", () => {
  it("generates a NON-EXTRACTABLE Ed25519 key bound to the wallet and persists it", async () => {
    const store = createMemoryDeviceKeyStore();
    const pair = await ensureDeviceKey(store, WALLET);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.algorithm.name).toBe("Ed25519");
    await expect(store.get()).resolves.toEqual({ pair, walletAddress: WALLET });
  });

  it("returns the same key for the same wallet on subsequent calls (stable device identity)", async () => {
    const store = createMemoryDeviceKeyStore();
    const first = await ensureDeviceKey(store, WALLET);
    const second = await ensureDeviceKey(store, WALLET);
    expect(second).toBe(first);
  });

  it("rotates the key when the stored one is bound to a different wallet (#816)", async () => {
    const store = createMemoryDeviceKeyStore();
    const oldPair = await ensureDeviceKey(store, WALLET);
    const newPair = await ensureDeviceKey(store, OTHER_WALLET);

    expect(newPair).not.toBe(oldPair);
    await expect(store.get()).resolves.toEqual({ pair: newPair, walletAddress: OTHER_WALLET });
  });

  it("the private key cannot be exported", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore(), WALLET);
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  });
});

describe("devicePublicKeyHex", () => {
  it("exports 32 bytes of lowercase hex", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore(), WALLET);
    const hex = await devicePublicKeyHex(pair);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signWithDeviceKey", () => {
  it("produces a valid 64-byte Ed25519 signature over the payload", async () => {
    const pair = await ensureDeviceKey(createMemoryDeviceKeyStore(), WALLET);
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
// #816 adds the case where the load succeeds but the key belongs to a
// different wallet than the one currently paired.
describe("checkDeviceKeyStatus", () => {
  it("'missing' on first run (store.get resolves undefined)", async () => {
    const check = await checkDeviceKeyStatus(createMemoryDeviceKeyStore(), WALLET);
    expect(check).toEqual({ status: "missing" });
  });

  it("'ok' with the pair when a valid key is stored for the paired wallet", async () => {
    const store = createMemoryDeviceKeyStore();
    const pair = await ensureDeviceKey(store, WALLET);
    const check = await checkDeviceKeyStatus(store, WALLET);
    expect(check.status).toBe("ok");
    expect(check.pair).toBe(pair);
  });

  it("'ok' without an expected wallet (pre-pairing probe)", async () => {
    const store = createMemoryDeviceKeyStore();
    await ensureDeviceKey(store, WALLET);
    expect((await checkDeviceKeyStatus(store)).status).toBe("ok");
  });

  it("'wallet_mismatch' when a valid key loads bound to a different wallet (#816)", async () => {
    const store = createMemoryDeviceKeyStore();
    const pair = await ensureDeviceKey(store, WALLET);
    const check = await checkDeviceKeyStatus(store, OTHER_WALLET);

    expect(check).toEqual({ status: "wallet_mismatch" });
    // The key itself is still intact, so recovery can safely re-pair instead
    // of treating this as a load failure or an unverified contract.
    await expect(store.get()).resolves.toEqual({ pair, walletAddress: WALLET });
  });

  it("'wallet_mismatch' for a leftover key after a re-pair rotates the wallet (#816)", async () => {
    const store: DeviceKeyStore = {
      get: async () => ({ pair: await validPair(), walletAddress: WALLET }),
      set: async () => {},
      clear: async () => {},
    };
    expect(await checkDeviceKeyStatus(store, OTHER_WALLET)).toEqual({
      status: "wallet_mismatch",
    });
  });

  it("'load_failed' when the store itself throws (corrupted storage/quota/wipe)", async () => {
    const brokenStore: DeviceKeyStore = {
      get: () => Promise.reject(new Error("IndexedDB is corrupted")),
      set: () => Promise.reject(new Error("unused")),
      clear: () => Promise.reject(new Error("unused")),
    };
    const check = await checkDeviceKeyStatus(brokenStore, WALLET);
    expect(check).toEqual({ status: "load_failed" });
  });

  it("'invalid' when a value loads but fails the integrity check (wrong format)", async () => {
    const store: DeviceKeyStore = {
      get: () => Promise.resolve({ notAKeyPair: true } as unknown as StoredDeviceKey),
      set: async () => {},
      clear: async () => {},
    };
    const check = await checkDeviceKeyStatus(store, WALLET);
    expect(check).toEqual({ status: "invalid" });
  });

  it("'invalid' when the stored private key is extractable (tampered/legacy shape)", async () => {
    const store = createMemoryDeviceKeyStore();
    const extractablePair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await store.set(extractablePair, WALLET);
    const check = await checkDeviceKeyStatus(store, WALLET);
    expect(check).toEqual({ status: "invalid" });
  });
});

async function validPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}
