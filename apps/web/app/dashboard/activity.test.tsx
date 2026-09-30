import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryTx } from "@/lib/history-types";
import { ActivityPanel } from "./activity";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

const ACCOUNT = "GACCOUNT0000000000000000000000000000000000000000000000000AAAA";
const COUNTERPARTY = "GCOUNTERPARTY00000000000000000000000000000000000000000AAAA";
const HASH = "a".repeat(64);

function row(overrides: Partial<HistoryTx> = {}): HistoryTx {
  return {
    id: "soroban:CUSDC:1-0",
    kind: "soroban",
    direction: "out",
    counterparty: COUNTERPARTY,
    amount: 2_500_000n, // 0.25 USDC at 7dp
    asset: { kind: "soroban", code: "USDC", decimals: 7, contractId: "CUSDC" },
    timestamp: "2026-09-28T03:13:02.000Z",
    status: "success",
    txHash: HASH,
    ...overrides,
  };
}

const { useActivityMock } = vi.hoisted(() => ({ useActivityMock: vi.fn() }));
vi.mock("@/lib/activity", () => ({ useActivity: useActivityMock }));

function activity(overrides: Record<string, unknown> = {}) {
  return {
    rows: [row()],
    isPending: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasMore: false,
    refetch: vi.fn(),
    loadMore: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ActivityPanel", () => {
  it("shows a loading state without blocking on history", () => {
    useActivityMock.mockReturnValue(activity({ isPending: true, rows: [] }));
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    expect(screen.getByText(/Loading activity/i)).toBeDefined();
  });

  it("surfaces an explicit retry state instead of an empty list when history fails", () => {
    // "History that intermittently shows nothing is worse than no history."
    useActivityMock.mockReturnValue(
      activity({ isError: true, isPending: false, rows: [] }),
    );
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.t be loaded/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("distinguishes a genuinely empty history from a failure", () => {
    useActivityMock.mockReturnValue(activity({ rows: [] }));
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    expect(screen.getByText(/No transactions yet/i)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("always renders an amount together with its asset", () => {
    useActivityMock.mockReturnValue(
      activity({
        rows: [
          row(),
          row({
            id: "classic:2",
            kind: "classic",
            amount: 123_456_789n, // 12.3456789 XLM
            asset: { kind: "classic", code: "XLM", decimals: 7, contractId: "" },
          }),
        ],
      }),
    );
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);

    const items = screen.getAllByRole("listitem");
    // Every row's accessible name names the asset, so a bare number is never
    // announced on its own.
    expect(items[0]?.textContent).toMatch(/0\.25 USDC/);
    expect(items[1]?.textContent).toMatch(/12\.3456789 XLM/);
    const labels = items.map(
      (item) => item.querySelector("b > span")?.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      expect.stringContaining("0.25 USDC"),
      expect.stringContaining("12.3456789 XLM"),
    ]);
  });

  it("links each row to the explorer entry for its transaction hash", () => {
    useActivityMock.mockReturnValue(activity());
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    const link = screen.getByRole("listitem") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    );
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("marks a failed transaction as failed rather than hiding it", () => {
    useActivityMock.mockReturnValue(activity({ rows: [row({ status: "failed" })] }));
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    expect(screen.getByText(/failed/i)).toBeDefined();
  });

  it("loads older rows on demand and stops at the end of history", async () => {
    const loadMore = vi.fn();
    const result = activity({ hasMore: true, loadMore });
    useActivityMock.mockReturnValue(result);
    const { unmount } = render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);

    fireEvent.click(screen.getByRole("button", { name: /load older/i }));
    expect(loadMore).toHaveBeenCalled();
    unmount();

    // Exhausted history says so instead of offering a button that does nothing.
    useActivityMock.mockReturnValue(activity({ hasMore: false }));
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    expect(screen.getByText(/end of history/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /load older/i })).toBeNull();
  });

  it("shows direction and counterparty for an incoming transfer", async () => {
    useActivityMock.mockReturnValue(
      activity({ rows: [row({ direction: "in", amount: 1_000_000n })] }),
    );
    render(<ActivityPanel accountId={ACCOUNT} network="testnet" />);
    const text = screen.getByRole("listitem").textContent ?? "";
    expect(text).toMatch(/Received · USDC/);
    await waitFor(() => expect(text).toContain("+0.1 USDC"));
  });
});
