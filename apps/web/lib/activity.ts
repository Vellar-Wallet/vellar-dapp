"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { Network } from "@vellar/types";
import type { HistoryTx } from "./history-types";
import { createHistoryClient, type HistoryClient } from "./history";
import { walletConfig } from "./config";

// Dashboard activity data hook (issue #403). Mirrors balances.ts: the SDK loads
// lazily, the client is module-scoped, and react-query owns
// loading/error/refetch state.
//
// The hook deliberately does NOT block dashboard render: consumers render their
// panel shell immediately and swap in content as the query resolves.
//
// A single useInfiniteQuery owns every page. An earlier draft modelled this as
// "first page" + "next page" queries that a component merged via setState
// during render, which is both a React anti-pattern and the reason the panel
// needed local accumulator state. useInfiniteQuery keeps the page list in one
// place, so "load older" is a fetchNextPage() and dedup happens once, here.

export const HISTORY_PAGE_SIZE = 20;

/**
 * Rows the panel actually renders, across every page loaded so far.
 *
 * A page is a LEDGER WINDOW, not "the next 20 transactions" — see
 * `lib/history.ts`. The node offers no reverse cursor, so a page has to read a
 * whole time-boxed window, and on a busy window that is hundreds of rows.
 * Rendering all of them would bury the dashboard, so the list is capped at the
 * newest N. Rows beyond the cap are not lost: they were rendered in an earlier
 * window, or `Load older` reaches further back. The cap only bounds one screen.
 */
export const HISTORY_DISPLAY_LIMIT = 50;

let client: HistoryClient | undefined;

function historyClient(): HistoryClient {
  client ??= createHistoryClient({
    rpcUrl: walletConfig().rpcUrl,
    horizonUrl: walletConfig().horizonUrl,
    networkPassphrase: walletConfig().networkPassphrase,
  });
  return client;
}

export interface ActivityPage {
  rows: HistoryTx[];
  nextCursor?: string;
}

export interface PaginatedActivityView {
  rows: HistoryTx[];
  totalFetched: number;
  nextCursor: string | undefined;
  hasMore: boolean;
  /** False when the entire history fits within a single page and there is no nextCursor (#596). */
  showPaginationControls: boolean;
}

/**
 * Flattens the fetched pages into one newest-first list, de-duplicated by row
 * id. The two rails can return the same underlying event on adjacent pages
 * when a cursor boundary lands mid-stream, and a repeated key would make React
 * drop a row.
 */
export function flattenPages(pages: ReadonlyArray<{ rows: HistoryTx[] }>): HistoryTx[] {
  const seen = new Set<string>();
  const rows: HistoryTx[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Fetches a single cursor-paginated activity page (#596).
 */
export async function fetchActivityPage(input: {
  accountId: string;
  network: Network;
  cursor?: string;
  pageSize?: number;
  client?: HistoryClient;
}): Promise<ActivityPage> {
  const pageSize = input.pageSize ?? HISTORY_PAGE_SIZE;
  const activeClient = input.client ?? historyClient();
  return activeClient.fetchPage({
    accountId: input.accountId,
    network: input.network,
    cursor: input.cursor,
    pageSize,
  });
}

/**
 * Computes the paginated slice and cursor state from the pages fetched so far (#596).
 * Initial load renders at most one `pageSize` slice (never the full unpaginated history),
 * and each subsequent page loaded advances the visible limit by `pageSize`.
 */
export function paginateActivityPages(
  pages: ReadonlyArray<ActivityPage>,
  pageSize: number = HISTORY_PAGE_SIZE,
): PaginatedActivityView {
  if (pages.length === 0) {
    return {
      rows: [],
      totalFetched: 0,
      nextCursor: undefined,
      hasMore: false,
      showPaginationControls: false,
    };
  }

  const allRows = flattenPages(pages);
  const pageCap = Math.min(pages.length * pageSize, HISTORY_DISPLAY_LIMIT);
  const rows = allRows.slice(0, pageCap);
  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.nextCursor;
  const hasMore = Boolean(nextCursor) || allRows.length > rows.length;
  const showPaginationControls = hasMore || pages.length > 1;

  return {
    rows,
    totalFetched: allRows.length,
    nextCursor,
    hasMore,
    showPaginationControls,
  };
}

/**
 * Activity for the account, newest first, paginated via `fetchNextPage`.
 *
 * A surfaced error is a real one: transient RPC failures are retried inside the
 * client, so what reaches this hook has already exhausted its retries. The
 * consumer must show a "history unavailable — retry" state rather than an empty
 * list, per the issue's hard requirement.
 */
export function useActivity(
  accountId: string | undefined,
  network: Network | undefined,
  options?: { pageSize?: number; client?: HistoryClient },
) {
  const pageSize = options?.pageSize ?? HISTORY_PAGE_SIZE;
  const query = useInfiniteQuery({
    queryKey: ["activity", accountId, network, pageSize],
    enabled: accountId !== undefined && network !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchActivityPage({
        accountId: accountId as string,
        network: network as Network,
        cursor: pageParam,
        pageSize,
        client: options?.client,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });

  const paginated = query.data
    ? paginateActivityPages(query.data.pages, pageSize)
    : paginateActivityPages([], pageSize);

  return {
    ...query,
    rows: paginated.rows,
    nextCursor: paginated.nextCursor,
    hasMore: query.hasNextPage || paginated.hasMore,
    showPaginationControls: query.hasNextPage || paginated.showPaginationControls,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => query.fetchNextPage(),
  };
}
