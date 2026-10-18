import { describe, expect, it, vi } from "vitest";
import { CONNECT_GRANT_CAPABILITIES, errorPayload, requestEnvelope } from "@vellar/provider-sdk";
import { addGrant, loadState, setPairedWallet, type KeyValueStore } from "./state";

vi.mock("wxt/browser", () => ({
  browser: {
    windows: {
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test${p}`,
      onMessage: { addListener: vi.fn() },
    },
  },
}));

import { createBackgroundController, type BackgroundDeps } from "../entrypoints/background";

function createMemoryKv(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
  };
}

function setupHarness(overrides: Partial<BackgroundDeps> = {}) {
  const kv = overrides.kv ?? createMemoryKv();
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const winRemovedListeners: Array<(windowId: number) => void> = [];
  const removedWindowIds: number[] = [];
  let nextWinId = 100;

  const windowsApi: NonNullable<BackgroundDeps["windowsApi"]> = {
    create: vi.fn(async () => ({ id: ++nextWinId })),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async (windowId: number) => {
      removedWindowIds.push(windowId);
    }),
    onRemoved: {
      addListener(cb) {
        winRemovedListeners.push(cb);
      },
    },
  };

  const tabsApi: NonNullable<BackgroundDeps["tabsApi"]> = {
    onRemoved: {
      addListener(cb) {
        tabRemovedListeners.push(cb);
      },
    },
  };

  const runtimeApi: NonNullable<BackgroundDeps["runtimeApi"]> = {
    getURL: (path: string) => `chrome-extension://test${path}`,
    onMessage: {
      addListener: vi.fn(),
    },
  };

  const errorReporter = {
    reportError: vi.fn(async () => {}),
  };

  const controller = createBackgroundController({
    kv,
    resolvePairOrigins: () => ["https://app.vellar.dev"],
    windowsApi,
    tabsApi,
    runtimeApi,
    errorReporter,
    ...overrides,
  });

  return {
    kv,
    controller,
    windowsApi,
    removedWindowIds,
    errorReporter,
    emitTabRemoved(tabId: number) {
      for (const listener of tabRemovedListeners) {
        listener(tabId);
      }
    },
  };
}

const PAIRED_WALLET = {
  address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  keyId: "cred-1",
  walletWasmHash: "ab".repeat(32),
  webAppOrigin: "https://app.vellar.dev",
};

describe("background tab closure cleanup (#585)", () => {
  it("rejects orphaned pending requests and closes the approval window when the requesting tab closes before approval", async () => {
    const { kv, controller, removedWindowIds, emitTabRemoved } = setupHarness();
    await setPairedWallet(kv, PAIRED_WALLET);

    const reqPromise = controller.handleProviderRequest(
      {
        type: "provider-request",
        envelope: requestEnvelope("req-connect-1", {
          method: "connect",
          params: { network: "testnet" },
        }),
      },
      { origin: "https://dapp.example", tab: { id: 42 } },
    );

    // Wait for async loadState + openApprovalWindow to queue the pending item.
    await vi.waitFor(() => {
      expect(controller.listPending()).toHaveLength(1);
      expect(controller.getApprovalWindowId()).toBe(101);
    });

    // User closes tab 42 before approving or declining.
    emitTabRemoved(42);

    await expect(reqPromise).resolves.toEqual(
      errorPayload("rejected", "Requesting tab was closed"),
    );
    expect(controller.listPending()).toEqual([]);
    expect(removedWindowIds).toEqual([101]);
    expect(controller.getApprovalWindowId()).toBeUndefined();
  });

  it("only cleans up requests from the closed tab and keeps the approval window open when other tabs still have pending requests", async () => {
    const { kv, controller, removedWindowIds, emitTabRemoved } = setupHarness();
    await setPairedWallet(kv, PAIRED_WALLET);

    const tab1Promise = controller.handleProviderRequest(
      {
        type: "provider-request",
        envelope: requestEnvelope("req-tab-10", {
          method: "connect",
          params: { network: "testnet" },
        }),
      },
      { origin: "https://dapp-one.example", tab: { id: 10 } },
    );

    const tab2Promise = controller.handleProviderRequest(
      {
        type: "provider-request",
        envelope: requestEnvelope("req-tab-20", {
          method: "connect",
          params: { network: "testnet" },
        }),
      },
      { origin: "https://dapp-two.example", tab: { id: 20 } },
    );

    await vi.waitFor(() => {
      expect(controller.listPending()).toHaveLength(2);
    });

    // Closing an unrelated tab (99) does nothing.
    emitTabRemoved(99);
    expect(controller.listPending()).toHaveLength(2);
    expect(removedWindowIds).toEqual([]);

    // Closing tab 10 rejects only req-tab-10 and leaves req-tab-20 pending.
    emitTabRemoved(10);
    await expect(tab1Promise).resolves.toEqual(
      errorPayload("rejected", "Requesting tab was closed"),
    );
    expect(controller.listPending().map((p) => p.id)).toEqual(["req-tab-20"]);
    expect(removedWindowIds).toEqual([]);

    // Closing tab 20 rejects req-tab-20 and now closes the approval window.
    emitTabRemoved(20);
    await expect(tab2Promise).resolves.toEqual(
      errorPayload("rejected", "Requesting tab was closed"),
    );
    expect(controller.listPending()).toEqual([]);
    expect(removedWindowIds).toEqual([101]);
  });

  it("aborts in-flight sign_transaction resolution cleanly when the requesting tab closes after approval starts", async () => {
    let finishSigning!: (signedXdr: string) => void;
    let failSigning!: (err: Error) => void;

    const fakeKeyPair = {
      publicKey: {} as CryptoKey,
      privateKey: {} as CryptoKey,
    };

    const { kv, controller, removedWindowIds, errorReporter, emitTabRemoved } = setupHarness({
      createDeviceKeyStore: () => ({
        get: async () => fakeKeyPair,
        set: async () => {},
        clear: async () => {},
      }),
      devicePublicKeyHexFn: async () => "ab".repeat(32),
      signTransactionXdrFn: () =>
        new Promise<string>((resolve, reject) => {
          finishSigning = resolve;
          failSigning = reject;
        }),
    });

    await setPairedWallet(kv, PAIRED_WALLET);
    await addGrant(kv, {
      origin: "https://dapp.example",
      accountId: PAIRED_WALLET.address,
      network: "testnet",
      capabilities: [...CONNECT_GRANT_CAPABILITIES],
      grantedAt: new Date().toISOString(),
    });

    const signPromise = controller.handleProviderRequest(
      {
        type: "provider-request",
        envelope: requestEnvelope("req-sign-1", {
          method: "sign_transaction",
          params: { xdr: "AAAA_UNSIGNED", network: "testnet" },
        }),
      },
      { origin: "https://dapp.example", tab: { id: 77 } },
    );

    await vi.waitFor(() => {
      expect(controller.listPending()).toHaveLength(1);
    });

    // User clicks Approve in the popup; async signing begins.
    const resolveCall = controller.handleResolvePending("req-sign-1", true);
    await vi.waitFor(() => {
      expect(finishSigning).toBeDefined();
    });

    // While signing is still in flight, the user closes tab 77.
    emitTabRemoved(77);

    await expect(signPromise).resolves.toEqual(
      errorPayload("rejected", "Requesting tab was closed"),
    );
    expect(removedWindowIds).toEqual([101]);

    // Even if the in-flight signing task rejects or resolves afterwards, it must
    // not report a spurious error or throw an unhandled rejection.
    failSigning(new Error("RPC connection aborted after tab closed"));
    await expect(resolveCall).resolves.toBe(false);
    expect(errorReporter.reportError).not.toHaveBeenCalled();
  });

  it("does not persist a stale paired wallet if the requesting tab closes while pair approval is in flight", async () => {
    let finishEnsureKey!: (pair: CryptoKeyPair) => void;

    const { kv, controller, emitTabRemoved } = setupHarness({
      ensureDeviceKeyFn: () =>
        new Promise<CryptoKeyPair>((resolve) => {
          finishEnsureKey = resolve;
        }),
      devicePublicKeyHexFn: async () => "cd".repeat(32),
    });

    const pairPromise = controller.handleProviderRequest(
      {
        type: "provider-request",
        envelope: requestEnvelope("req-pair-1", {
          method: "pair",
          params: {
            address: PAIRED_WALLET.address,
            network: "testnet",
            rpcUrl: PAIRED_WALLET.rpcUrl,
            keyId: PAIRED_WALLET.keyId,
            walletWasmHash: PAIRED_WALLET.walletWasmHash,
          },
        }),
      },
      { origin: "https://app.vellar.dev", tab: { id: 55 } },
    );

    await vi.waitFor(() => {
      expect(controller.listPending()).toHaveLength(1);
    });

    const resolveCall = controller.handleResolvePending("req-pair-1", true);
    await vi.waitFor(() => {
      expect(finishEnsureKey).toBeDefined();
    });

    // Tab 55 closes before device key generation finishes.
    emitTabRemoved(55);

    await expect(pairPromise).resolves.toEqual(
      errorPayload("rejected", "Requesting tab was closed"),
    );

    finishEnsureKey({
      publicKey: {} as CryptoKey,
      privateKey: {} as CryptoKey,
    });
    await expect(resolveCall).resolves.toBe(false);

    // State must remain unpaired because the pairing tab closed mid-handshake.
    const state = await loadState(kv);
    expect(state.pairedWallet).toBeUndefined();
  });
});
