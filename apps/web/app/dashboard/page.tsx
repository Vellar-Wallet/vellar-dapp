"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatTokenAmount } from "vellar-sdk";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, Frame, LpActionButton } from "@/app/landing/ui";
import { useBalances } from "@/lib/balances";
import { useWalletSession } from "@/lib/wallet-context";
import { getAnalyticsTracker, walletCreationEvents } from "@/lib/analytics";
import { ReceiveCard } from "./receive-card";
import { SendPayment } from "./send-payment";
import { SwapPanel } from "./swap-panel";
import { ActivityPanel } from "./activity";

// Wallet dashboard ("paper & signals" shell, design.md §8): panel grid —
// Account overview (balance + details) · My assets · Activity. Send/Receive
// open as focused panels replacing the grid.

type Panel = "grid" | "send" | "receive" | "swap";

export default function Dashboard() {
  const session = useWalletSession();
  const balances = useBalances(session?.accountId);
  const [panel, setPanel] = useState<Panel>("grid");

  useEffect(() => {
    // Emit funnel completion event when dashboard mounts with active session
    if (session) {
      const extSession = session as {
        contractId?: string;
        sessionId?: string;
        accountId?: string;
      };
      walletCreationEvents.funnelCompleted({
        network: session.network,
        contractId: extSession.contractId ?? session.accountId ?? "",
        sessionId: extSession.sessionId
          ? getAnalyticsTracker().hashValue(extSession.sessionId)
          : getAnalyticsTracker().hashValue(session.accountId ?? "unknown"),
      });
      void getAnalyticsTracker().flush();
    }
  }, [session]);

  const native = balances.data?.find((b) => b.symbol === "XLM");
  const total = native ? formatTokenAmount(native.amount, native.decimals) : "0";

  return (
    <AppShell
      actions={[
        { label: "Send", onClick: () => setPanel("send"), primary: true },
        { label: "Receive", onClick: () => setPanel("receive") },
        { label: "Swap", onClick: () => setPanel("swap") },
      ]}
    >
      {panel === "receive" && session && (
        <div className="max-w-[460px]">
          <ReceiveCard
            accountId={session.accountId}
            network={session.network}
            onClose={() => setPanel("grid")}
          />
        </div>
      )}

      {panel === "send" && session && (
        <div className="max-w-[460px]">
          <button
            onClick={() => setPanel("grid")}
            className="mb-3.5 block cursor-pointer font-[family-name:var(--lp-mono)] text-xs font-bold text-[var(--lp-ink-faint)]"
          >
            ← Wallet
          </button>
          {native ? (
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

      {panel === "swap" && session && (
        <div className="max-w-[460px]">
          <button
            onClick={() => setPanel("grid")}
            className="mb-3.5 block cursor-pointer font-[family-name:var(--lp-mono)] text-xs font-bold text-[var(--lp-ink-faint)]"
          >
            ← Wallet
          </button>
          <SwapPanel
            from={session.accountId}
            network={session.network}
            onSuccess={() => void balances.refetch()}
          />
        </div>
      )}

      {panel === "grid" && (
        <div className="grid items-start gap-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {/* Account overview — the primary panel (design.md §8) */}
          <Frame className="flex flex-col">
            <section className="lpa-panel flex flex-1 flex-col">
              <Eyebrow>Account balance</Eyebrow>
              <div className="lpa-balance mt-2.5">
                {balances.isPending ? (
                  <span className="animate-pulse text-[var(--lp-ink-faint)]">…</span>
                ) : (
                  <>
                    {total} <span className="unit">XLM</span>
                  </>
                )}
              </div>

              {Boolean(balances.error) && (
                <div className="mt-3 flex items-center gap-3">
                  <span role="alert" className="lpa-bad text-[13px]">
                    Couldn&apos;t load balances.
                  </span>
                  <LpActionButton
                    variant="outline"
                    size="sm"
                    onClick={() => void balances.refetch()}
                  >
                    Retry
                  </LpActionButton>
                </div>
              )}

              <dl className="lpa-detail mt-6">
                <DetailRow label="Account name" value={session?.accountId.slice(-8) ?? ""} />
                <DetailRow
                  label="Public key"
                  value={
                    session ? `${session.accountId.slice(0, 6)}…${session.accountId.slice(-6)}` : ""
                  }
                  mono
                />
                <DetailRow label="Network" value={session?.network ?? ""} />
                <DetailRow label="Auth method" value="Passkey" />
                {session?.createdAt && (
                  <DetailRow
                    label="Wallet since"
                    value={new Date(session.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  />
                )}
                {session?.lastActiveAt && (
                  <DetailRow
                    label="Last active"
                    value={new Date(session.lastActiveAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  />
                )}
              </dl>
            </section>
          </Frame>

          {/* My assets */}
          <section className="lpa-panel min-h-[260px]">
            <Eyebrow>My assets</Eyebrow>
            {balances.isPending && (
              <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading…</p>
            )}
            {balances.data?.length ? (
              <div className="mt-1.5">
                {balances.data.map((b) => (
                  <div key={b.contractId} className="lpa-tokrow">
                    <div className="ti"></div>
                    <div className="tn">
                      <b>{b.symbol === "XLM" ? "Stellar Lumens" : b.symbol}</b>
                      <span>{b.symbol}</span>
                    </div>
                    <div className="tv">
                      <b className="lpa-amt text-base">{formatTokenAmount(b.amount, b.decimals)}</b>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              !balances.isPending && (
                <div className="lpa-empty mt-6">
                  <div className="ph" />
                  <p className="text-sm!">No assets yet</p>
                  <LpActionButton variant="outline" size="sm" onClick={() => setPanel("receive")}>
                    Receive assets
                  </LpActionButton>
                </div>
              )
            )}
          </section>

          {/* Activity (issue #403): real transaction history, paginated
              newest-first. Rendered inside its own panel so a slow history
              fetch never blocks the balance/assets panels. */}
          <section className="lpa-panel min-h-[260px]">
            <Eyebrow>Activity</Eyebrow>
            {session && (
              <ActivityPanel accountId={session.accountId} network={session.network} />
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="lpa-detail-row">
      <dt>{label}</dt>
      <dd className={mono ? "font-[family-name:var(--lp-mono)] text-[13px]" : "capitalize"}>
        {value}
      </dd>
    </div>
  );
}
