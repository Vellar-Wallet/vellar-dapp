import { describe, expect, it } from "vitest";
import type { PermissionGrant } from "@vellar/provider-sdk";
import {
  addGrant,
  clearPairedWallet,
  loadState,
  MAX_PAIRED_ORIGINS,
  PairedOriginLimitError,
  revokeGrant,
  setPairedWallet,
  type KeyValueStore,
} from "./state";

function memoryKv(initial?: Record<string, unknown>): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

const grant: PermissionGrant = {
  origin: "https://dapp.example",
  accountId: "CABC",
  network: "testnet",
  capabilities: ["connect", "view_address", "sign"],
  grantedAt: "2026-07-16T10:00:00.000Z",
};

describe("loadState", () => {
  it("returns empty state for fresh storage", async () => {
    await expect(loadState(memoryKv())).resolves.toEqual({ grants: [] });
  });

  it("returns empty state for corrupt storage instead of crashing", async () => {
    const kv = memoryKv({ "vela.extension.state": { grants: "nonsense" } });
    await expect(loadState(kv)).resolves.toEqual({ grants: [] });
  });

  it("returns empty state when storage itself throws", async () => {
    const kv: KeyValueStore = {
      get: async () => {
        throw new Error("storage broken");
      },
      set: async () => {},
    };
    await expect(loadState(kv)).resolves.toEqual({ grants: [] });
  });
});

describe("pairing", () => {
  it("stores the paired wallet", async () => {
    const kv = memoryKv();
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    const state = await loadState(kv);
    expect(state.pairedWallet).toEqual({
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
  });

  it("pairing a different wallet wipes grants for the old one", async () => {
    const kv = memoryKv();
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    await addGrant(kv, grant);
    await setPairedWallet(kv, {
      address: "COTHER",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    expect((await loadState(kv)).grants).toEqual([]);
  });

  it("re-pairing the same wallet keeps grants", async () => {
    const kv = memoryKv();
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    await addGrant(kv, grant);
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    expect((await loadState(kv)).grants).toHaveLength(1);
  });

  it("round-trips the webAppOrigin and tolerates its absence (older pairings)", async () => {
    const kv = memoryKv();
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
      webAppOrigin: "http://localhost:3000",
    });
    expect((await loadState(kv)).pairedWallet?.webAppOrigin).toBe("http://localhost:3000");

    // Absent field (pre-existing pairing) still parses.
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    expect((await loadState(kv)).pairedWallet?.webAppOrigin).toBeUndefined();
  });

  it("clearPairedWallet removes wallet and grants", async () => {
    const kv = memoryKv();
    await setPairedWallet(kv, {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    });
    await addGrant(kv, grant);
    await clearPairedWallet(kv);
    await expect(loadState(kv)).resolves.toEqual({ grants: [] });
  });
});

describe("grants", () => {
  it("adds and replaces grants per origin+network", async () => {
    const kv = memoryKv();
    await addGrant(kv, grant);
    await addGrant(kv, { ...grant, capabilities: ["connect"] });
    const state = await loadState(kv);
    expect(state.grants).toHaveLength(1);
    expect(state.grants[0]?.capabilities).toEqual(["connect"]);
  });

  it("keeps grants for the same origin on different networks separate", async () => {
    const kv = memoryKv();
    await addGrant(kv, grant);
    await addGrant(kv, { ...grant, network: "mainnet" });
    expect((await loadState(kv)).grants).toHaveLength(2);
  });

  it("revokes and reports whether anything was removed", async () => {
    const kv = memoryKv();
    await addGrant(kv, grant);
    await expect(revokeGrant(kv, "https://dapp.example", "testnet")).resolves.toBe(true);
    await expect(revokeGrant(kv, "https://dapp.example", "testnet")).resolves.toBe(false);
    expect((await loadState(kv)).grants).toEqual([]);
  });
});

// #579: an explicit, configurable ceiling on distinct paired dApp origins.
describe("paired-origin limit (#579)", () => {
  function originGrant(i: number): PermissionGrant {
    return { ...grant, origin: `https://dapp-${i}.example` };
  }

  it("the last allowed pairing (exactly reaching the limit) still succeeds", async () => {
    const kv = memoryKv();
    for (let i = 0; i < MAX_PAIRED_ORIGINS; i++) {
      await addGrant(kv, originGrant(i));
    }
    const state = await loadState(kv);
    expect(state.grants).toHaveLength(MAX_PAIRED_ORIGINS);
  });

  it("pairing one more ORIGIN past the limit throws PairedOriginLimitError", async () => {
    const kv = memoryKv();
    for (let i = 0; i < MAX_PAIRED_ORIGINS; i++) {
      await addGrant(kv, originGrant(i));
    }
    await expect(addGrant(kv, originGrant(MAX_PAIRED_ORIGINS))).rejects.toBeInstanceOf(
      PairedOriginLimitError,
    );
    // Rejected pairing must not have been persisted.
    expect((await loadState(kv)).grants).toHaveLength(MAX_PAIRED_ORIGINS);
  });

  it("at the limit, granting a NEW network for an ALREADY-paired origin is never blocked", async () => {
    const kv = memoryKv();
    for (let i = 0; i < MAX_PAIRED_ORIGINS; i++) {
      await addGrant(kv, originGrant(i));
    }
    // origin-0 is already paired (testnet); adding mainnet for the SAME origin
    // doesn't add a new distinct origin, so it must not be blocked by the limit.
    await expect(addGrant(kv, { ...originGrant(0), network: "mainnet" })).resolves.toBeUndefined();
    expect((await loadState(kv)).grants).toHaveLength(MAX_PAIRED_ORIGINS + 1);
  });

  it("at the limit, replacing the grant for an already-paired origin+network is never blocked", async () => {
    const kv = memoryKv();
    for (let i = 0; i < MAX_PAIRED_ORIGINS; i++) {
      await addGrant(kv, originGrant(i));
    }
    await expect(
      addGrant(kv, { ...originGrant(0), capabilities: ["connect"] }),
    ).resolves.toBeUndefined();
    const state = await loadState(kv);
    expect(state.grants).toHaveLength(MAX_PAIRED_ORIGINS);
    expect(state.grants.find((g) => g.origin === originGrant(0).origin)?.capabilities).toEqual([
      "connect",
    ]);
  });

  it("the error message suggests unpairing an unused origin", async () => {
    const kv = memoryKv();
    for (let i = 0; i < MAX_PAIRED_ORIGINS; i++) {
      await addGrant(kv, originGrant(i));
    }
    await expect(addGrant(kv, originGrant(MAX_PAIRED_ORIGINS))).rejects.toThrow(/unpair/i);
  });
});
