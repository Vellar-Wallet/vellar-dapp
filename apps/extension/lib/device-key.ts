// Device signer key management (docs/decisions.md 2026-07-16 option 1A).
// The Ed25519 private key is generated NON-EXTRACTABLE in WebCrypto: it can
// sign in place but can never be exported — not by the extension's own code,
// not by anything reading storage. The key store seam is IndexedDB in the
// browser (CryptoKey objects are structured-cloneable) and memory in tests.

export interface DeviceKeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  set(pair: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
}

export type DeviceKeyFailureReason =
  "storage_read_error" | "corrupted_key_record" | "missing_paired_device_key";

export class DeviceKeyLoadError extends Error {
  readonly code = "device_key_load_failed" as const;
  readonly reason: DeviceKeyFailureReason;
  readonly recoveryAction = "re-pair" as const;
  override readonly cause: unknown;

  constructor(reason: DeviceKeyFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = "DeviceKeyLoadError";
    this.reason = reason;
    this.cause = cause;
  }
}

export type DeviceKeyLoadStatus =
  | {
      status: "ready";
      pair: CryptoKeyPair;
    }
  | {
      status: "absent";
      onboardingRequired: true;
    }
  | {
      status: "recovery_required";
      reason: DeviceKeyFailureReason;
      message: string;
      recoveryAction: "re-pair";
      error: DeviceKeyLoadError;
    };

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates that a value loaded from storage is a genuine, non-extractable
 * Ed25519 WebCrypto keypair rather than a corrupted or partial record.
 */
export function isValidDeviceKeyPair(candidate: unknown): candidate is CryptoKeyPair {
  if (typeof candidate !== "object" || candidate === null) return false;
  const pair = candidate as Partial<CryptoKeyPair>;
  if (
    typeof pair.privateKey !== "object" ||
    pair.privateKey === null ||
    typeof pair.publicKey !== "object" ||
    pair.publicKey === null
  ) {
    return false;
  }
  const priv = pair.privateKey;
  const pub = pair.publicKey;
  if (priv.type !== "private" || pub.type !== "public") return false;
  if (priv.extractable !== false) return false;
  if (priv.algorithm?.name !== "Ed25519" || pub.algorithm?.name !== "Ed25519") {
    return false;
  }
  if (!Array.isArray(priv.usages) || !priv.usages.includes("sign")) return false;
  return true;
}

/**
 * Loads the device key on popup open / startup and distinguishes:
 * 1. `ready`: valid Ed25519 device keypair loaded from storage
 * 2. `absent`: first-run state (no key stored and no wallet paired yet)
 * 3. `recovery_required`: storage read error, corrupted key record, or missing
 *    device key while a wallet is already paired — surfaces a dedicated
 *    re-pair recovery path distinct from first-run onboarding.
 */
export async function loadDeviceKeyWithRecovery(
  store: DeviceKeyStore,
  options: { isWalletPaired?: boolean } = {},
): Promise<DeviceKeyLoadStatus> {
  let loaded: CryptoKeyPair | undefined;
  try {
    loaded = await store.get();
  } catch (err) {
    const error = new DeviceKeyLoadError(
      "storage_read_error",
      "Failed to load your device signer key from browser storage. Reset and re-pair this extension with your wallet to continue.",
      err,
    );
    return {
      status: "recovery_required",
      reason: "storage_read_error",
      message: error.message,
      recoveryAction: "re-pair",
      error,
    };
  }

  if (loaded === undefined) {
    if (options.isWalletPaired) {
      const error = new DeviceKeyLoadError(
        "missing_paired_device_key",
        "Your paired device signer key is missing from browser storage. Re-pair this extension from the Vellar web app to restore signing.",
      );
      return {
        status: "recovery_required",
        reason: "missing_paired_device_key",
        message: error.message,
        recoveryAction: "re-pair",
        error,
      };
    }
    return {
      status: "absent",
      onboardingRequired: true,
    };
  }

  if (!isValidDeviceKeyPair(loaded)) {
    const error = new DeviceKeyLoadError(
      "corrupted_key_record",
      "Stored device signer key is corrupted or unreadable. Reset the device key and re-pair this extension with your wallet.",
    );
    return {
      status: "recovery_required",
      reason: "corrupted_key_record",
      message: error.message,
      recoveryAction: "re-pair",
      error,
    };
  }

  return {
    status: "ready",
    pair: loaded,
  };
}

/**
 * Clears any corrupted or unreadable device key from storage and generates a
 * fresh non-extractable Ed25519 device keypair so the user can re-pair cleanly.
 */
export async function recoverDeviceKey(store: DeviceKeyStore): Promise<CryptoKeyPair> {
  try {
    await store.clear();
  } catch {
    // Proceed to overwrite via set() even if clear() failed on a wedged entry.
  }
  const freshPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  await store.set(freshPair);
  return freshPair;
}

/** Returns the existing device key or generates a fresh non-extractable one. */
export async function ensureDeviceKey(store: DeviceKeyStore): Promise<CryptoKeyPair> {
  try {
    const existing = await store.get();
    if (existing && isValidDeviceKeyPair(existing)) return existing;
    if (existing !== undefined) {
      await store.clear().catch(() => {});
    }
  } catch {
    await store.clear().catch(() => {});
  }
  // "verify" lands on the public key (needed for self-checks); the private
  // key gets only "sign" and stays non-extractable.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  await store.set(pair);
  return pair;
}

/** Raw 32-byte Ed25519 public key, hex-encoded (crosses to the web app for addEd25519). */
export async function devicePublicKeyHex(pair: CryptoKeyPair): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return bytesToHex(raw);
}

/** Signs a payload with the device key (64-byte Ed25519 signature). */
export async function signWithDeviceKey(
  pair: CryptoKeyPair,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    payload as BufferSource,
  );
  return new Uint8Array(signature);
}

export function createMemoryDeviceKeyStore(): DeviceKeyStore {
  let stored: CryptoKeyPair | undefined;
  return {
    async get() {
      return stored;
    },
    async set(pair) {
      stored = pair;
    },
    async clear() {
      stored = undefined;
    },
  };
}

/** IndexedDB-backed store (production): CryptoKey is structured-cloneable. */
export function createIdbDeviceKeyStore(dbName = "vela-device-key"): DeviceKeyStore {
  const STORE = "keys";
  const KEY = "device";

  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    });
  }

  async function tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
      });
    } finally {
      db.close();
    }
  }

  return {
    get: () => tx<CryptoKeyPair | undefined>("readonly", (s) => s.get(KEY)),
    set: (pair) => tx<void>("readwrite", (s) => s.put(pair, KEY)),
    clear: () => tx<void>("readwrite", (s) => s.delete(KEY)),
  };
}
