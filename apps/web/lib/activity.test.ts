import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryTx } from "./history-types";
import type { HistoryClient } from "./history";
import {
  fetchActivityPage,
  flattenPages,
  HISTORY_PAGE_SIZE,
  paginateActivityPages,
  useActivity,
} from "./activity";

function makeTx(id: string): HistoryTx {
  return {
    id,
    kind: "soroban",
    direction: "out",
    counterparty: "GCOUNTERPARTY00000000000000000000000000000000000000000AAAA",
    amount: 1_000_000n,
    asset: { kind: "soroban", code: "USDC", decimals: 7, contractId: "CUSDC" },
    timestamp: "2026-09-28T03:13:02.000Z",
    status: "success",
    txHash: "a".repeat(64),
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("activity pagination (#596)", () => {
  it("fetches only the first page on initial load and exposes nextCursor/hasMore", async () => {
    const page1Rows = Array.from({ length: 5 }, (_, i) => makeTx(`tx-${i + 1}`));
    const mockClient: HistoryClient = {
      fetchPage: vi.fn().mockResolvedValue({
        rows: page1Rows,
        nextCursor: "cursor-page-2",
      }),
    };

    const page = await fetchActivityPage({
      accountId: "C_ACCOUNT",
      network: "testnet",
      pageSize: 5,
      client: mockClient,
    });

    expect(mockClient.fetchPage).toHaveBeenCalledTimes(1);
    expect(mockClient.fetchPage).toHaveBeenCalledWith({
      accountId: "C_ACCOUNT",
      network: "testnet",
      cursor: undefined,
      pageSize: 5,
    });

    const view = paginateActivityPages([page], 5);
    expect(view.rows).toHaveLength(5);
    expect(view.nextCursor).toBe("cursor-page-2");
    expect(view.hasMore).toBe(true);
    expect(view.showPaginationControls).toBe(true);
  });

  it("loads subsequent pages via cursor and deduplicates overlapping boundary rows", async () => {
    const page1 = {
      rows: [makeTx("tx-1"), makeTx("tx-2"), makeTx("tx-3")],
      nextCursor: "cursor-after-3",
    };
    const page2 = {
      rows: [makeTx("tx-3"), makeTx("tx-4"), makeTx("tx-5")],
      nextCursor: undefined,
    };

    const mockClient: HistoryClient = {
      fetchPage: vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2),
    };

    const first = await fetchActivityPage({
      accountId: "C_ACCOUNT",
      network: "testnet",
      pageSize: 3,
      client: mockClient,
    });
    const second = await fetchActivityPage({
      accountId: "C_ACCOUNT",
      network: "testnet",
      cursor: first.nextCursor,
      pageSize: 3,
      client: mockClient,
    });

    expect(mockClient.fetchPage).toHaveBeenNthCalledWith(2, {
      accountId: "C_ACCOUNT",
      network: "testnet",
      cursor: "cursor-after-3",
      pageSize: 3,
    });

    const view = paginateActivityPages([first, second], 3);
    expect(view.rows.map((r) => r.id)).toEqual(["tx-1", "tx-2", "tx-3", "tx-4", "tx-5"]);
    expect(view.nextCursor).toBeUndefined();
    expect(view.hasMore).toBe(false);
    expect(view.showPaginationControls).toBe(true);
  });

  it("marks hasMore=false and hides pagination controls when history is shorter than one page", () => {
    const shortPage = {
      rows: [makeTx("tx-only-1"), makeTx("tx-only-2")],
      nextCursor: undefined,
    };

    const view = paginateActivityPages([shortPage], HISTORY_PAGE_SIZE);
    expect(view.rows).toHaveLength(2);
    expect(view.nextCursor).toBeUndefined();
    expect(view.hasMore).toBe(false);
    expect(view.showPaginationControls).toBe(false);
  });

  it("useActivity loads page 1 initially and fetches page 2 when loadMore is called", async () => {
    const mockClient: HistoryClient = {
      fetchPage: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [makeTx("tx-1"), makeTx("tx-2")],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          rows: [makeTx("tx-3")],
          nextCursor: undefined,
        }),
    };

    const { result } = renderHook(
      () => useActivity("C_ACCOUNT", "testnet", { pageSize: 2, client: mockClient }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(mockClient.fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.rows.map((r) => r.id)).toEqual(["tx-1", "tx-2"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.nextCursor).toBe("cursor-2");

    await result.current.loadMore();
    await waitFor(() =>
      expect(result.current.rows.map((r) => r.id)).toEqual(["tx-1", "tx-2", "tx-3"]),
    );
    expect(mockClient.fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.hasMore).toBe(false);
  });

  it("flattenPages preserves order and drops duplicate transaction ids", () => {
    const merged = flattenPages([
      { rows: [makeTx("a"), makeTx("b")] },
      { rows: [makeTx("b"), makeTx("c")] },
    ]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
