/**
 * Tests for App.tsx's live storage-change refresh and HomeScreen's empty
 * state (#588).
 *
 * Covers:
 *  - the "Connected dApps" empty state shows explicit copy with a call to
 *    action explaining how to pair a dApp, not just a blank list
 *  - a grant added via browser.storage.onChanged (simulating a pairing that
 *    completed while this popup instance was already open, e.g. in a
 *    separate approval window) makes the empty state disappear immediately,
 *    without the popup needing to be closed and reopened
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const storageState = new Map<string, unknown>();
const onChangedListeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];

const sendMessageMock = vi.fn().mockResolvedValue([]);

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => (storageState.has(key) ? { [key]: storageState.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = storageState.get(key);
            storageState.set(key, value);
            for (const listener of onChangedListeners) {
              listener({ [key]: { oldValue, newValue: value } }, "local");
            }
          }
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, areaName: string) => void) => {
          onChangedListeners.push(fn);
        },
        removeListener: (fn: (changes: Record<string, unknown>, areaName: string) => void) => {
          const index = onChangedListeners.indexOf(fn);
          if (index !== -1) onChangedListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      sendMessage: (message: unknown) => sendMessageMock(message),
    },
  },
}));

const { App } = await import("./App");
const { STATE_KEY } = await import("../../lib/state");

const WALLET = {
  address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH234567ABCDEF",
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  keyId: "key-1",
  walletWasmHash: "hash-1",
};

afterEach(() => {
  cleanup();
  storageState.clear();
  onChangedListeners.length = 0;
  sendMessageMock.mockClear();
  sendMessageMock.mockResolvedValue([]);
  // Reset the approval-window query param between tests.
  window.history.replaceState({}, "", "/");
});

describe("HomeScreen empty state for zero paired origins (#588)", () => {
  it("shows explicit empty-state copy with a call to action, not just a blank list", async () => {
    storageState.set(STATE_KEY, { pairedWallet: WALLET, grants: [] });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/No dApps connected yet/)).toBeTruthy());
    expect(screen.getByText(/Connect wallet/)).toBeTruthy();
  });
});

describe("App live storage-change refresh (#588)", () => {
  it("removes the empty state immediately when a grant is added via storage.onChanged, without a popup reopen", async () => {
    storageState.set(STATE_KEY, { pairedWallet: WALLET, grants: [] });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/No dApps connected yet/)).toBeTruthy());

    // Simulate a pairing completing elsewhere (e.g. a separate approval
    // window) while this popup instance stays mounted: a direct
    // browser.storage.local.set, not a user action inside this component.
    const { browserKv } = await import("../../lib/browser-kv");
    await browserKv.set(STATE_KEY, {
      pairedWallet: WALLET,
      grants: [
        {
          origin: "https://dapp.example",
          accountId: WALLET.address,
          network: "testnet",
          capabilities: ["connect", "view_address"],
          grantedAt: new Date().toISOString(),
        },
      ],
    });

    await waitFor(() => expect(screen.queryByText(/No dApps connected yet/)).toBeNull());
    expect(screen.getByText("dapp.example")).toBeTruthy();
  });
});
