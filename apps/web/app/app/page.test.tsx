import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { VelaProvider } from "@vellar/provider-sdk";
import { rememberPairing } from "@/lib/extension-pairing";
import { WalletProvider } from "@/lib/wallet-context";
import AppEntry from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("@/lib/connector-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connector-factory")>();
  return { ...actual, getWalletRuntime: runtimeMock };
});

const connectedSession: WalletSession = {
  accountId: "CACCOUNT574",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  keyId: "cred-574",
};

function setWindowVela(provider: VelaProvider | undefined) {
  Object.defineProperty(window, "vela", {
    value: provider,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  setWindowVela(undefined);
});

describe("AppEntry (/app)", () => {
  it("renders the onboarding actions", () => {
    render(
      <WalletProvider>
        <AppEntry />
      </WalletProvider>,
    );
    expect(screen.getByRole("button", { name: "Create wallet" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(screen.getByLabelText(/wallet name/i)).toBeDefined();
  });

  it("detects when a paired extension is uninstalled mid-session and surfaces a clear re-pairing prompt (#574)", async () => {
    window.localStorage.setItem("vellar.session", JSON.stringify(connectedSession));
    rememberPairing(connectedSession.accountId, {
      hash: "tx-initial-pair",
      expiresAt: "2026-07-23T09:00:00.000Z",
    });

    const initialProvider: VelaProvider = {
      pairStatus: vi.fn().mockResolvedValue({ paired: true }),
      pair: vi.fn(),
      connect: vi.fn(),
      getAccount: vi.fn(),
      getNetwork: vi.fn(),
      signTransaction: vi.fn(),
    };
    setWindowVela(initialProvider);

    render(
      <WalletProvider>
        <AppEntry />
      </WalletProvider>,
    );

    expect(await screen.findByTestId("extension-paired-status")).toBeDefined();

    // Simulate extension being uninstalled mid-session (window.vela removed)
    setWindowVela(undefined);

    fireEvent.click(screen.getByRole("button", { name: /check extension connection/i }));

    const prompt = await screen.findByTestId("extension-reconnect-prompt");
    expect(prompt.textContent).toMatch(/re-pairing required/i);
    expect(prompt.textContent).toMatch(/uninstalled or disabled mid-session/i);
    expect(screen.getByRole("button", { name: /re-pair extension/i })).toBeDefined();
  });

  it("recovers within the same web session when the extension is reinstalled and re-paired without a page reload (#574)", async () => {
    window.localStorage.setItem("vellar.session", JSON.stringify(connectedSession));
    rememberPairing(connectedSession.accountId, {
      hash: "tx-initial-pair",
      expiresAt: "2026-07-23T09:00:00.000Z",
    });

    // Extension starts disconnected (e.g. invalidated port when action is attempted)
    const brokenProvider: VelaProvider = {
      pairStatus: vi.fn().mockRejectedValue(new Error("Extension context invalidated")),
      pair: vi.fn(),
      connect: vi.fn(),
      getAccount: vi.fn(),
      getNetwork: vi.fn(),
      signTransaction: vi.fn(),
    };
    setWindowVela(brokenProvider);

    render(
      <WalletProvider>
        <AppEntry />
      </WalletProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /check extension connection/i }));

    const prompt = await screen.findByTestId("extension-reconnect-prompt");
    expect(prompt.textContent).toMatch(/re-pairing required/i);

    // User reinstalls the extension in the same web session (new provider injected on window.vela)
    const reinstalledProvider: VelaProvider = {
      pairStatus: vi.fn().mockResolvedValue({ paired: true }),
      pair: vi.fn().mockResolvedValue({
        devicePublicKeyHex: "ab".repeat(32),
        expiresAt: "2026-07-30T09:00:00.000Z",
      }),
      connect: vi.fn(),
      getAccount: vi.fn(),
      getNetwork: vi.fn(),
      signTransaction: vi.fn(),
    };
    setWindowVela(reinstalledProvider);

    const addDeviceSigner = vi.fn().mockResolvedValue({
      hash: "tx-repaired-574",
      expiresAt: "2026-07-30T09:00:00.000Z",
    });
    runtimeMock.mockResolvedValue({
      resume: vi.fn().mockResolvedValue(undefined),
      addDeviceSigner,
    });

    fireEvent.click(screen.getByRole("button", { name: /re-pair extension/i }));

    await waitFor(() => expect(reinstalledProvider.pair).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(addDeviceSigner).toHaveBeenCalledWith("ab".repeat(32)));

    const pairedStatus = await screen.findByTestId("extension-paired-status");
    expect(pairedStatus.textContent).toMatch(/extension paired to this wallet/i);
    expect(screen.queryByTestId("extension-reconnect-prompt")).toBeNull();
  });
});
