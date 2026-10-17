import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { WalletConnector } from "vellar-sdk";
import type { PasskeyEnvironment } from "@vellar/passkey";
import { WalletProvider } from "@/lib/wallet-context";
import { OnboardingActions } from "./onboarding-actions";

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

const session: WalletSession = {
  accountId: "CABC",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

const supportedEnv: PasskeyEnvironment = {
  isSecureContext: true,
  publicKeyCredential: {},
};

function fakeConnector(overrides: Partial<WalletConnector> = {}): WalletConnector {
  return {
    createWallet: vi.fn().mockResolvedValue(session),
    connectWallet: vi.fn().mockResolvedValue(session),
    signTransaction: vi.fn(),
    ...overrides,
  };
}

function renderActions(connector: WalletConnector, environment: PasskeyEnvironment = supportedEnv) {
  return render(
    <WalletProvider connector={connector}>
      <OnboardingActions environment={environment} />
    </WalletProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("OnboardingActions", () => {
  it("creates a wallet with the entered name and navigates to the dashboard", async () => {
    const connector = fakeConnector();
    renderActions(connector);

    fireEvent.change(screen.getByLabelText(/wallet name/i), { target: { value: "dumto" } });
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(connector.createWallet).toHaveBeenCalledWith({ username: "dumto", network: "testnet" });
    // Session persisted for restore on next load.
    expect(window.localStorage.getItem("vellar.session")).toContain("CABC");
  });

  it("signs in with an existing passkey", async () => {
    const connector = fakeConnector();
    renderActions(connector);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(connector.connectWallet).toHaveBeenCalledWith("testnet");
  });

  it("stays quiet when the user cancels the passkey prompt", async () => {
    const cancel = new Error("dismissed");
    cancel.name = "NotAllowedError";
    const connector = fakeConnector({ createWallet: vi.fn().mockRejectedValue(cancel) });
    renderActions(connector);

    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Create wallet" }).disabled,
      ).toBe(false),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("passkey-cancelled-notice").textContent).toBe(
      "The passkey prompt was dismissed. Try again when you're ready.",
    );
  });

  it("handles passkey creation cancelled mid-flow (AbortError or cause-wrapped NotAllowedError), preserves username, and recovers cleanly on retry (#575)", async () => {
    const abortErr = new Error("The operation either timed out or was not allowed.");
    abortErr.name = "AbortError";
    const wrappedCancel = new Error("WebAuthn registration failed", {
      cause: Object.assign(new Error("User cancelled"), { name: "NotAllowedError" }),
    });

    const createWallet = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockRejectedValueOnce(wrappedCancel)
      .mockResolvedValueOnce(session);

    const connector = fakeConnector({ createWallet });
    renderActions(connector);

    const nameInput = screen.getByLabelText<HTMLInputElement>(/wallet name/i);
    fireEvent.change(nameInput, { target: { value: "alice" } });

    // First attempt: user aborts passkey dialog mid-flow
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Create wallet" }).disabled,
      ).toBe(false),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/passkey prompt was dismissed/i);
    expect(nameInput.value).toBe("alice");

    // Second attempt: wrapped NotAllowedError cause is also treated as user cancellation
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() => expect(createWallet).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Create wallet" }).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("passkey-cancelled-notice")).toBeTruthy();

    // Third attempt: user completes passkey creation — notice clears and navigates to dashboard
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(createWallet).toHaveBeenCalledTimes(3);
    expect(createWallet).toHaveBeenLastCalledWith({ username: "alice", network: "testnet" });
    expect(screen.queryByTestId("passkey-cancelled-notice")).toBeNull();
  });

  it("surfaces real failures as an error message", async () => {
    const connector = fakeConnector({
      createWallet: vi.fn().mockRejectedValue(new Error("relayer down")),
    });
    renderActions(connector);

    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/something went wrong/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("disables actions and explains when passkeys are unsupported", async () => {
    renderActions(fakeConnector(), { isSecureContext: true, publicKeyCredential: undefined });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/doesn't support passkeys/i);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create wallet" }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign in" }).disabled).toBe(true);
  });
});
