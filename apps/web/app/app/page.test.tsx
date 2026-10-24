import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import { WalletProvider } from "@/lib/wallet-context";
import AppEntry from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const mockPairExtension = vi.fn();
vi.mock("@/lib/extension-pairing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/extension-pairing")>(
    "@/lib/extension-pairing",
  );
  return {
    ...actual,
    pairExtension: (...args: unknown[]) => mockPairExtension(...args),
  };
});

const session: WalletSession = {
  accountId: "CSMARTWALLET123",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
  keyId: "cred123",
};

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as { vela?: unknown }).vela;
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

  it("detects that the extension is uninstalled when an action is attempted and surfaces re-pairing prompt", async () => {
    // Window has no vela extension injected
    render(
      <WalletProvider initialSession={session}>
        <AppEntry />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger-extension-action"));

    const alert = await screen.findByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toMatch(/not responding or has been uninstalled.*re-pair/i);
    expect(screen.getByRole("button", { name: /re-pair extension/i })).toBeDefined();
  });

  it("recovers gracefully when extension is reinstalled and re-paired in the same session without page reload", async () => {
    // 1. Initial state: extension is uninstalled
    render(
      <WalletProvider initialSession={session}>
        <AppEntry />
      </WalletProvider>,
    );

    // Attempt extension action -> fails and displays re-pairing prompt
    fireEvent.click(screen.getByTestId("trigger-extension-action"));
    expect(await screen.findByRole("alert")).toBeDefined();
    const repairBtn = screen.getByRole("button", { name: /re-pair extension/i });

    // 2. Extension is re-installed mid-session (injected into window)
    (window as { vela?: unknown }).vela = {
      pairStatus: vi.fn().mockResolvedValue({ paired: true }),
      pair: vi.fn().mockResolvedValue({ devicePublicKeyHex: "abcd" }),
    };
    mockPairExtension.mockResolvedValue({ hash: "hash123", expiresAt: "2026-10-27" });

    // 3. User clicks Re-pair extension without reloading page
    fireEvent.click(repairBtn);

    await waitFor(() => {
      expect(mockPairExtension).toHaveBeenCalledWith(session);
    });

    // Alert disappears and success banner appears
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("extension-repaired-banner").textContent).toMatch(/re-paired successfully/i);
  });

  it("completes extension action successfully when extension is responding normally", async () => {
    const pairStatus = vi.fn().mockResolvedValue({ paired: true });
    (window as { vela?: unknown }).vela = { pairStatus };

    render(
      <WalletProvider initialSession={session}>
        <AppEntry />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger-extension-action"));

    await waitFor(() => expect(pairStatus).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
