"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Eyebrow } from "@/app/landing/ui";
import { useBalances } from "@/lib/balances";
import { useWalletSession } from "@/lib/wallet-context";
import { SendPayment } from "@/app/dashboard/send-payment";
import { SwapPanel } from "@/app/dashboard/swap-panel";
export { isMemoRequiredDestination, MEMO_REQUIRED_DESTINATIONS } from "@/lib/memo-destinations";

// Send / Swap page (design.md §7): one focused column, a Send | Swap
// segmented switch on top, the existing flows below. Both flows keep their
// own build -> review -> passkey sign -> track steps; this page only hosts
// them. `?tab=swap` deep-links the swap side (the dashboard's Swap action).

type Tab = "send" | "swap";

function tabFromUrl(): Tab {
  return new URLSearchParams(window.location.search).get("tab") === "swap" ? "swap" : "send";
}

export default function SendSwapPage() {
  const session = useWalletSession();
  const balances = useBalances(session?.accountId);
  const [tab, setTab] = useState<Tab>("send");

  useEffect(() => {
    setTab(tabFromUrl());
  }, []);

  function select(next: Tab) {
    setTab(next);
    // Keep the URL shareable without adding a history entry per toggle.
    const url = new URL(window.location.href);
    if (next === "swap") url.searchParams.set("tab", "swap");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  }

  const native = balances.data?.find((b) => b.symbol === "XLM");

  return (
    <AppShell>
      <div className="max-w-[460px]">
        <h1>{tab === "send" ? "Send" : "Swap"}</h1>

        <div role="tablist" aria-label="Send or swap" className="lpa-seg mt-4 mb-5">
          <SegTab id="send" label="Send" active={tab === "send"} onSelect={select} />
          <SegTab id="swap" label="Swap" active={tab === "swap"} onSelect={select} />
        </div>

        {session && tab === "send" && (
          <div role="tabpanel" id="panel-send" aria-labelledby="tab-send">
            {balances.isPending ? (
              <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading…</p>
            ) : native ? (
              <SendPayment
                from={session.accountId}
                token={native}
                availableTokens={balances.data}
                network={session.network}
                onSuccess={() => void balances.refetch()}
              />
            ) : (
              <section className="lpa-panel">
                <Eyebrow>Send</Eyebrow>
                <p className="mt-3! text-sm text-[var(--lp-ink-soft)]">
                  Fund the wallet first — receive some XLM, then come back to send.
                </p>
              </section>
            )}
            <Link
              href="/pay"
              className="mt-3.5 block font-[family-name:var(--lp-mono)] text-xs font-bold text-[var(--lp-ink-faint)]"
            >
              Have a payment request link? Pay it →
            </Link>
          </div>
        )}

        {session && tab === "swap" && (
          <div role="tabpanel" id="panel-swap" aria-labelledby="tab-swap">
            <SwapPanel
              from={session.accountId}
              network={session.network}
              onSuccess={() => void balances.refetch()}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}

function SegTab({
  id,
  label,
  active,
  onSelect,
}: {
  id: Tab;
  label: string;
  active: boolean;
  onSelect: (tab: Tab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={`panel-${id}`}
      className={active ? "active" : undefined}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}
