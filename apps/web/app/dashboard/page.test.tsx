import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vela/types";
import { WalletProvider } from "@/lib/wallet-context";
import Dashboard from "./page";

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/dashboard",
}));

const { useBalancesMock } = vi.hoisted(() => ({ useBalancesMock: vi.fn() }));
vi.mock("@/lib/balances", () => ({
  useBalances: useBalancesMock,
}));

const session: WalletSession = {
  accountId: "CDASHBOARD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567XYZ99",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

function withBalances() {
  useBalancesMock.mockReturnValue({
    data: [{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 12345000n }],
    isPending: false,
    error: null,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useBalancesMock.mockReturnValue({
    data: undefined,
    isPending: true,
    error: null,
    refetch: vi.fn(),
  });
});

describe("Dashboard", () => {
  it("leads with the balance and shows the truncated account in the shell", async () => {
    window.localStorage.setItem("vela.session", JSON.stringify(session));
    withBalances();

    render(
      <WalletProvider>
        <Dashboard />
      </WalletProvider>,
    );

    // Balance appears in the hero and the assets row.
    expect((await screen.findAllByText("1.2345")).length).toBeGreaterThan(0);
    // Shell actions.
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Receive" })).toBeDefined();
    // Truncated address in the topbar; full string not rendered on the grid.
    const short = `${session.accountId.slice(0, 5)}…${session.accountId.slice(-5)}`;
    expect(
      screen.getByText(new RegExp(short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeDefined();
    expect(replace).not.toHaveBeenCalled();
  });

  it("opens the receive panel with the full address", async () => {
    window.localStorage.setItem("vela.session", JSON.stringify(session));
    withBalances();

    render(
      <WalletProvider>
        <Dashboard />
      </WalletProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Receive" }));
    expect(screen.getByText(session.accountId)).toBeDefined();
    expect(screen.getByRole("button", { name: /copy address/i })).toBeDefined();
  });

  it("opens the send panel", async () => {
    window.localStorage.setItem("vela.session", JSON.stringify(session));
    withBalances();

    render(
      <WalletProvider>
        <Dashboard />
      </WalletProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: /review payment/i })).toBeDefined();
  });

  it("redirects to onboarding when there is no session", async () => {
    render(
      <WalletProvider>
        <Dashboard />
      </WalletProvider>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
  });
});
