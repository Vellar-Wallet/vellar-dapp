import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { HistoryTx } from "@/lib/history-types";
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

// The activity panel owns a react-query infinite query against testnet; the
// dashboard tests are about the surrounding grid, so it is stubbed the same
// way balances is. Its own behaviour is covered in activity.test.tsx.
const { useActivityMock } = vi.hoisted(() => ({ useActivityMock: vi.fn() }));
vi.mock("@/lib/activity", () => ({
  useActivity: useActivityMock,
}));

function noActivity() {
  useActivityMock.mockReturnValue({
    rows: [],
    isPending: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasMore: false,
    refetch: vi.fn(),
    loadMore: vi.fn(),
  });
}

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
  noActivity();
  useBalancesMock.mockReturnValue({
    data: undefined,
    isPending: true,
    error: null,
    refetch: vi.fn(),
  });
});

describe("Dashboard", () => {
  it("leads with the balance and shows the truncated account in the shell", async () => {
    window.localStorage.setItem("vellar.session", JSON.stringify(session));
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
    window.localStorage.setItem("vellar.session", JSON.stringify(session));
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
    window.localStorage.setItem("vellar.session", JSON.stringify(session));
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

describe("Dashboard — zero balance with transaction history (#798)", () => {
  // A wallet that was just swept empty is not a brand-new wallet: it still has
  // activity to show. The dashboard must render a zero balance AND the history,
  // rather than collapsing into a single empty-wallet treatment.
  const sweptOut: HistoryTx = {
    id: "classic:sweep",
    kind: "classic",
    direction: "out",
    counterparty: "GDESTINATION00000000000000000000000000000000000000000AAAA",
    amount: 12_345_000n, // 1.2345 XLM at 7dp
    asset: { kind: "classic", code: "XLM", decimals: 7, contractId: "" },
    timestamp: "2026-11-22T09:00:00.000Z",
    status: "success",
    txHash: "b".repeat(64),
  };

  function renderSweptWallet(
    balanceData: Array<{ symbol: string; contractId: string; decimals: number; amount: bigint }>,
    activity = {
      rows: [sweptOut],
      isPending: false,
      isError: false,
      isFetching: false,
      isFetchingNextPage: false,
      hasMore: false,
      refetch: vi.fn(),
      loadMore: vi.fn(),
    },
  ) {
    window.localStorage.setItem("vellar.session", JSON.stringify(session));
    useBalancesMock.mockReturnValue({
      data: balanceData,
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });
    useActivityMock.mockReturnValue(activity);
    return render(
      <WalletProvider>
        <Dashboard />
      </WalletProvider>,
    );
  }

  it("shows a zero balance alongside the past transfer", async () => {
    renderSweptWallet([{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 0n }]);

    // Both the hero balance and the asset row report zero, not a blank state.
    expect((await screen.findAllByText("0")).length).toBeGreaterThan(0);
    expect(screen.queryByText("No assets yet")).toBeNull();
    // The history is still there, distinguished from a never-used wallet.
    expect(await screen.findByText(/1\.2345 XLM/)).toBeDefined();
    expect(screen.queryByText(/No transactions yet/i)).toBeNull();
  });

  it("keeps the transfer visible when no asset rows remain at all", async () => {
    renderSweptWallet([]);

    expect(await screen.findByText(/1\.2345 XLM/)).toBeDefined();
    // The assets panel says it is empty, but the page as a whole does not
    // imply that nothing ever happened.
    expect(screen.getByText("No assets yet")).toBeDefined();
    expect(screen.queryByText(/No transactions yet/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Receive" })).toBeDefined();
  });

  it("keeps the zero-balance panels usable when the history fetch fails", async () => {
    renderSweptWallet([{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 0n }], {
      rows: [],
      isPending: false,
      isError: true,
      isFetching: false,
      isFetchingNextPage: false,
      hasMore: false,
      refetch: vi.fn(),
      loadMore: vi.fn(),
    });

    expect((await screen.findAllByText("0")).length).toBeGreaterThan(0);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn.t be loaded/i);
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });
});
