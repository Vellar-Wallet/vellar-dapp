import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest, ResponsePayload } from "@vellar/provider-sdk";
import { PairedTabManager } from "./paired-tab-manager";

describe("PairedTabManager (#585 tab lifecycle cleanup)", () => {
  const reqPair: ProviderRequest = {
    method: "pair",
    params: {
      address: "CABC",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "k1",
      walletWasmHash: "ab".repeat(32),
    },
  };

  const reqSign: ProviderRequest = {
    method: "sign_transaction",
    params: {
      network: "testnet",
      xdr: "AAAA...",
    },
  };

  it("Tab closes before approval -> pending cleaned up, popup canceled", async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const manager = new PairedTabManager({ closeWindow });
    manager.approvalWindowId = 42;

    let resolvedPayload: ResponsePayload | undefined;
    manager.addPending({
      id: "req-1",
      origin: "https://dapp.example",
      request: reqPair,
      tabId: 101,
      resolve: (payload) => {
        resolvedPayload = payload;
      },
    });

    expect(manager.getPendingCount()).toBe(1);
    expect(manager.listPending()).toHaveLength(1);

    // Tab 101 closes
    await manager.handleTabRemoved(101);

    // 1. Pending cleaned up
    expect(manager.getPendingCount()).toBe(0);
    expect(manager.getPending("req-1")).toBeUndefined();
    expect(manager.listPending()).toEqual([]);

    // 2. Resolved with rejected payload
    expect(resolvedPayload).toEqual({
      error: {
        code: "rejected",
        message: "The initiating tab was closed",
      },
    });

    // 3. Popup window closed
    expect(closeWindow).toHaveBeenCalledWith(42);
    expect(manager.approvalWindowId).toBeUndefined();
  });

  it("Tab closes before approval when other tab still pending -> only closed tab cleaned, popup stays open", async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const manager = new PairedTabManager({ closeWindow });
    manager.approvalWindowId = 42;

    let resolved1: ResponsePayload | undefined;
    let resolved2: ResponsePayload | undefined;

    manager.addPending({
      id: "req-1",
      origin: "https://dapp1.example",
      request: reqPair,
      tabId: 101,
      resolve: (p) => {
        resolved1 = p;
      },
    });

    manager.addPending({
      id: "req-2",
      origin: "https://dapp2.example",
      request: reqSign,
      tabId: 102,
      resolve: (p) => {
        resolved2 = p;
      },
    });

    expect(manager.getPendingCount()).toBe(2);

    // Tab 101 closes
    await manager.handleTabRemoved(101);

    // Tab 101's request is cleaned up
    expect(manager.getPending("req-1")).toBeUndefined();
    expect(resolved1).toEqual({
      error: { code: "rejected", message: "The initiating tab was closed" },
    });

    // Tab 102's request remains pending
    expect(manager.getPending("req-2")).toBeDefined();
    expect(resolved2).toBeUndefined();
    expect(manager.getPendingCount()).toBe(1);

    // Popup window was NOT closed because Tab 102 is still waiting
    expect(closeWindow).not.toHaveBeenCalled();
    expect(manager.approvalWindowId).toBe(42);
  });

  it("Tab closes after approval -> handled cleanly without errors or dangling promises", async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const manager = new PairedTabManager({ closeWindow });
    manager.approvalWindowId = 42;

    let promiseSettled = false;
    let finalPayload: ResponsePayload | undefined;

    const requestPromise = new Promise<ResponsePayload>((resolve) => {
      manager.addPending({
        id: "req-1",
        origin: "https://dapp.example",
        request: reqSign,
        tabId: 101,
        resolve: (payload) => {
          promiseSettled = true;
          finalPayload = payload;
          resolve(payload);
        },
      });
    });

    // User approves in popup -> moves to resolving
    const entry = manager.startResolving("req-1");
    expect(entry).toBeDefined();
    expect(manager.getPending("req-1")).toBeUndefined();

    // Now, before cryptographic signing / response delivery completes, tab 101 closes!
    await manager.handleTabRemoved(101);

    // Manager notes that the tab closed for this in-flight resolution
    expect(manager.isTabClosedForInFlight("req-1")).toBe(true);

    // Crypto finishes and delivers response
    const signResult: ResponsePayload = {
      method: "sign_transaction",
      result: { signedXdr: "AAAA_SIGNED" },
    };

    // Completing resolution must not throw, must resolve the promise cleanly
    expect(() => manager.finishResolving("req-1", signResult)).not.toThrow();

    await expect(requestPromise).resolves.toEqual(signResult);
    expect(promiseSettled).toBe(true);
    expect(finalPayload).toEqual(signResult);

    // Popup window is cleaned up
    expect(closeWindow).toHaveBeenCalledWith(42);
    expect(manager.approvalWindowId).toBeUndefined();
  });

  it("Normal flow (tab stays open) still succeeds", async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const manager = new PairedTabManager({ closeWindow });
    manager.approvalWindowId = 42;

    let finalPayload: ResponsePayload | undefined;
    const requestPromise = new Promise<ResponsePayload>((resolve) => {
      manager.addPending({
        id: "req-1",
        origin: "https://dapp.example",
        request: reqSign,
        tabId: 101,
        resolve: (payload) => {
          finalPayload = payload;
          resolve(payload);
        },
      });
    });

    expect(manager.getPendingCount()).toBe(1);

    // User approves
    const entry = manager.startResolving("req-1");
    expect(entry).toBeDefined();

    // Work finishes normally
    const signResult: ResponsePayload = {
      method: "sign_transaction",
      result: { signedXdr: "AAAA_SIGNED" },
    };
    manager.finishResolving("req-1", signResult);

    await expect(requestPromise).resolves.toEqual(signResult);
    expect(finalPayload).toEqual(signResult);
    expect(manager.getPendingCount()).toBe(0);
  });

  it("supersedes older pending requests from same origin and method", () => {
    const manager = new PairedTabManager();
    let oldPayload: ResponsePayload | undefined;

    manager.addPending({
      id: "req-1",
      origin: "https://dapp.example",
      request: reqPair,
      tabId: 101,
      resolve: (p) => {
        oldPayload = p;
      },
    });

    manager.supersedePending("https://dapp.example", "pair");

    expect(manager.getPending("req-1")).toBeUndefined();
    expect(oldPayload).toEqual({
      error: {
        code: "rejected",
        message: "Superseded by a newer request",
      },
    });
  });

  it("handles window removed event without error", () => {
    const manager = new PairedTabManager();
    manager.approvalWindowId = 42;

    manager.handleWindowRemoved(99);
    expect(manager.approvalWindowId).toBe(42);

    manager.handleWindowRemoved(42);
    expect(manager.approvalWindowId).toBeUndefined();
  });
});
