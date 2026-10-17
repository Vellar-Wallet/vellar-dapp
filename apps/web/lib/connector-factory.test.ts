import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { WalletConnector } from "vellar-sdk";
import {
  ConnectorInitializationError,
  createConnectorWithFallback,
  createExtensionFallbackConnector,
  createRealConnector,
  resetWalletRuntime,
} from "./connector-factory";

const mockSession: WalletSession = {
  accountId: "C_FALLBACK_WALLET",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

function makeFakeConnector(accountId = mockSession.accountId): WalletConnector {
  return {
    createWallet: vi.fn().mockResolvedValue({ ...mockSession, accountId }),
    connectWallet: vi.fn().mockResolvedValue({ ...mockSession, accountId }),
    signTransaction: vi.fn().mockResolvedValue({ signedXdr: "SIGNED_XDR" }),
  };
}

describe("connector-factory fallback initialization (#601)", () => {
  beforeEach(() => {
    resetWalletRuntime();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetWalletRuntime();
    delete (window as { vela?: unknown }).vela;
  });

  it("returns the preferred connector without calling the fallback when primary succeeds", async () => {
    const primary = makeFakeConnector("C_PRIMARY");
    const fallback = makeFakeConnector("C_FALLBACK");
    const fallbackFactory = vi.fn().mockResolvedValue(fallback);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const connector = await createRealConnector({
      preferred: () => Promise.resolve(primary),
      fallback: fallbackFactory,
    });

    expect(connector).toBe(primary);
    expect(fallbackFactory).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the secondary connector and logs a warning when the preferred connector fails to initialize", async () => {
    const primaryError = new Error("PasskeyKit WebAuthn initialization failed");
    const fallback = makeFakeConnector("C_SECONDARY");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const connector = await createRealConnector({
      preferred: () => Promise.reject(primaryError),
      fallback: () => Promise.resolve(fallback),
    });

    expect(connector).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Connector candidate #1 failed to initialize; attempting fallback/i),
      primaryError,
    );

    // Verify the returned fallback connector is usable end-to-end
    const connected = await connector.connectWallet("testnet");
    expect(connected.accountId).toBe("C_SECONDARY");
    const signed = await connector.signTransaction({ xdr: "UNSIGNED_XDR", network: "testnet" });
    expect(signed).toEqual({ signedXdr: "SIGNED_XDR" });
  });

  it("falls back to the injected window.vela extension provider when the preferred connector fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (window as { vela?: unknown }).vela = {
      connect: vi.fn().mockResolvedValue({ address: "C_EXT_WALLET", network: "testnet" }),
      signTransaction: vi.fn().mockResolvedValue({ signedXdr: "EXT_SIGNED_XDR" }),
    };

    const connector = await createConnectorWithFallback({
      preferred: () => {
        throw new Error("Passkey runtime unavailable");
      },
      fallback: createExtensionFallbackConnector,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const session = await connector.connectWallet("testnet");
    expect(session.accountId).toBe("C_EXT_WALLET");
    expect(session.network).toBe("testnet");
    expect(session.connected).toBe(true);

    const signed = await connector.signTransaction({ xdr: "RAW_XDR", network: "testnet" });
    expect(signed.signedXdr).toBe("EXT_SIGNED_XDR");
  });

  it("throws a structured ConnectorInitializationError when all connectors fail to initialize", async () => {
    const err1 = new Error("Primary PasskeyKit failed");
    const err2 = new Error("Fallback extension unavailable");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let caught: unknown;
    try {
      await createRealConnector({
        candidates: [
          () => Promise.reject(err1),
          () => {
            throw err2;
          },
        ],
      });
    } catch (err) {
      caught = err;
    }

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(ConnectorInitializationError);
    const initErr = caught as ConnectorInitializationError;
    expect(initErr.code).toBe("CONNECTOR_INIT_FAILED");
    expect(initErr.message).toBe("No supported wallet connector available");
    expect(initErr.causes).toEqual([err1, err2]);
    expect(initErr.cause).toBe(err2);
  });
});
