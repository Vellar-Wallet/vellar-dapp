"use client";

import { formatTokenAmount } from "vellar-sdk";
import type { Network } from "@vellar/types";
import { LpActionButton } from "@/app/landing/ui";
import { useActivity } from "@/lib/activity";
import type { HistoryTx } from "@/lib/history-types";
import { explorerTxUrl } from "@/lib/explorer";

// Activity panel (issue #403, technical-doc.md §5.2): per-transaction
// direction, counterparty, asset + amount, timestamp, status, and an explorer
// link for the tx hash. Rendered inside the dashboard grid — history loading
// must never block the dashboard, so this panel owns its own states and the
// page stays live while it resolves.

const MONO = "font-[family-name:var(--lp-mono)]";

export function ActivityPanel({
  accountId,
  network,
}: {
  accountId: string;
  network: Network;
}) {
  const activity = useActivity(accountId, network);

  if (activity.isPending) {
    return (
      <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]" aria-live="polite">
        Loading activity…
      </p>
    );
  }

  if (activity.isError) {
    // Transient failures are retried inside the client; a surfaced error here
    // is real — show it and a retry affordance, never an empty list.
    return (
      <div className="mt-3.5">
        <p role="alert" className="lpa-bad text-sm">
          History couldn&apos;t be loaded — the network view was unavailable.
        </p>
        <LpActionButton
          variant="outline"
          size="sm"
          className="mt-2.5"
          onClick={() => void activity.refetch()}
        >
          Retry
        </LpActionButton>
      </div>
    );
  }

  const { rows, hasMore, isLoadingMore, loadMore } = activity;

  if (rows.length === 0) {
    return (
      <div className="lpa-empty mt-6">
        <div className="ph" />
        <p className="text-sm!">No transactions yet</p>
        <p className="max-w-[220px] text-[13px] text-[var(--lp-ink-faint)]">
          Payments you send or receive will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <div role="list" aria-label="Transaction history">
        {rows.map((row) => (
          <ActivityRow key={row.id} row={row} accountId={accountId} network={network} />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        {hasMore ? (
          <LpActionButton
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? "Loading…" : "Load older"}
          </LpActionButton>
        ) : (
          <span className="text-[13px] text-[var(--lp-ink-faint)]">End of history</span>
        )}
        <LpActionButton
          variant="ghost"
          size="sm"
          onClick={() => void activity.refetch()}
          disabled={activity.isFetching}
        >
          Refresh
        </LpActionButton>
      </div>
    </div>
  );
}

function ActivityRow({
  row,
  accountId,
  network,
}: {
  row: HistoryTx;
  accountId: string;
  network: Network;
}) {
  const signed = row.direction === "out" ? "−" : row.direction === "in" ? "+" : "±";
  const dirLabel =
    row.direction === "out" ? "Sent" : row.direction === "in" ? "Received" : "Self";
  const amount = formatTokenAmount(
    row.amount < 0n ? -row.amount : row.amount,
    row.asset.decimals,
  );
  const counterpartyLabel = shortAddress(row.counterparty || accountId);
  const failed = row.status === "failed";

  return (
    <a
      role="listitem"
      href={explorerTxUrl(row.txHash, network)}
      target="_blank"
      rel="noreferrer"
      className="lpa-tokrow"
      title={`View transaction ${row.txHash}`}
    >
      <div className="ti" aria-hidden="true" />
      <div className="tn">
        <b>
          {dirLabel} · {row.asset.code}
        </b>
        <span className={MONO}>{counterpartyLabel}</span>
        <span className={MONO}>{formatTimestamp(row.timestamp)}</span>
      </div>
      <div className="tv">
        <b className="lpa-amt text-base">
          {/* The asset symbol is part of the amount's accessible name, so the
              number is never announced — or read — without its unit. */}
          <span aria-label={`${dirLabel} ${amount} ${row.asset.code}${failed ? ", failed" : ""}`}>
            {signed}
            {amount} {row.asset.code}
          </span>
        </b>
        <span
          className={`block text-right text-[11px] ${MONO} ${failed ? "lpa-bad" : "text-[var(--lp-ink-faint)]"}`}
        >
          {failed ? "✗ failed" : "✓ success"}
        </span>
      </div>
    </a>
  );
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
