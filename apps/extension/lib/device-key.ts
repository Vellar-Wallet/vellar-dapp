// Device signer key management (docs/decisions.md 2026-07-16 option 1A).
// The Ed25519 private key is generated NON-EXTRACTABLE in WebCrypto: it can
// sign in place but can never be exported — not by the extension's own code,
// not by anything reading storage. The key store seam is IndexedDB in the
// browser (CryptoKey objects are structured-cloneable) and memory in tests.

/** A stored key is bound to the wallet it was generated for. A load that
 * succeeds but carries a different wallet address is a wallet mismatch, not a
 * usable key, and must never sign for the newly paired wallet (#816). */
export interface StoredDeviceKey {
  pair: CryptoKeyPair;
  walletAddress: string;
}

export interface DeviceKeyStore {
  get(): Promise<StoredDeviceKey | undefined>;
  set(pair: CryptoKeyPair, walletAddress: string): Promise<void>;
  clear(): Promise<void>;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Device-key status for the popup (#581). Distinct from a crash: a failure to
 * load (corrupted storage, quota issue, storage wiped) must surface a clear
 * recovery path, never fail silently and never be confused with first-run
 * "no key yet" — those need different copy and different actions (re-pair vs.
 * "pair for the first time").
 *  - "ok"          a usable key pair was loaded.
 *  - "missing"     no key is stored yet (first run — normal, pre-pairing).
 *  - "load_failed" `store.get()` itself threw (corrupted storage, quota, wipe).
 *  - "invalid"     a value was loaded but fails a basic integrity check (e.g.
 *                  wrong shape/algorithm) — distinct from a clean absence.
 *  - "wallet_mismatch" a valid key was loaded but it is bound to a different
 *                  wallet than the one currently paired (stale state from
 *                  before a re-pair). Signing with it would use the wrong
 *                  identity, so it needs the same recovery path as "invalid".
 */
export type DeviceKeyStatus = "ok" | "missing" | "load_failed" | "invalid" | "wallet_mismatch";

export interface DeviceKeyCheck {
  status: DeviceKeyStatus;
  pair?: CryptoKeyPair;
}

/** Basic integrity check on a loaded key pair: right shape, right algorithm,
 * private key still usable to sign and still non-extractable. A key that
 * loads but fails this is "invalid", not silently treated as absent. */
function isValidDeviceKeyPair(value: unknown): value is CryptoKeyPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<CryptoKeyPair>;
  const priv = pair.privateKey as CryptoKey | undefined;
  const pub = pair.publicKey as CryptoKey | undefined;
  if (!priv || !pub) return false;
  if (priv.type !== "private" || pub.type !== "public") return false;
  if (priv.algorithm?.name !== "Ed25519" || pub.algorithm?.name !== "Ed25519") return false;
  if (priv.extractable !== false) return false;
  return true;
}

/**
 * Checks the device key without generating one (read-only — safe to call on
 * every popup open). Never throws: a load failure resolves to
 * `{ status: "load_failed" }` so the popup can show a recovery path instead
 * of crashing or silently rendering as if nothing were paired.
 */
export async function checkDeviceKeyStatus(
  store: DeviceKeyStore,
  walletAddress?: string,
): Promise<DeviceKeyCheck> {
  let stored: StoredDeviceKey | undefined;
  try {
    stored = await store.get();
  } catch {
    return { status: "load_failed" };
  }
  if (stored === undefined) return { status: "missing" };
  if (!isValidDeviceKeyPair(stored.pair)) return { status: "invalid" };
  // A successful load is not enough: a key left over from a previous pairing
  // would sign with the old identity. Only compare when the caller knows the
  // currently paired address, so a pre-pairing probe still reports "ok".
  if (walletAddress !== undefined && stored.walletAddress !== walletAddress) {
    return { status: "wallet_mismatch" };
  }
  return { status: "ok", pair: stored.pair };
}

/**
 * Returns the device key bound to `walletAddress`, generating a fresh
 * non-extractable one when nothing usable is stored. A key bound to another
 * wallet is never reused: re-pairing must rotate the local signer (#816).
 */
export async function ensureDeviceKey(
  store: DeviceKeyStore,
  walletAddress: string,
): Promise<CryptoKeyPair> {
  const existing = await store.get();
  if (existing && existing.walletAddress === walletAddress && isValidDeviceKeyPair(existing.pair)) {
    return existing.pair;
  }
  // "verify" lands on the public key (needed for self-checks); the private
  // key gets only "sign" and stays non-extractable.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  await store.set(pair, walletAddress);
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
  let stored: StoredDeviceKey | undefined;
  return {
    async get() {
      return stored;
    },
    async set(pair, walletAddress) {
      stored = { pair, walletAddress };
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
    get: () => tx<StoredDeviceKey | undefined>("readonly", (s) => s.get(KEY)),
    set: (pair, walletAddress) =>
      tx<void>("readwrite", (s) => s.put({ pair, walletAddress } satisfies StoredDeviceKey, KEY)),
    clear: () => tx<void>("readwrite", (s) => s.delete(KEY)),
  };
}
