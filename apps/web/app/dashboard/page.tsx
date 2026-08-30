"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "vellar-sdk";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { useBalances } from "@/lib/balances";
import { useWalletSession } from "@/lib/wallet-context";
import { getAnalyticsTracker, walletCreationEvents } from "@/lib/analytics";
import { ReceiveCard } from "./receive-card";
import { SendPayment } from "./send-payment";

// Wallet dashboard ("paper & signals" shell): panel grid — Account overview
// (balance + details) · My assets · Activity. Send/Receive open as focused
// panels replacing the grid.

type Panel = "grid" | "send" | "receive";

export default function Dashboard() {
  const session = useWalletSession();
  const balances = useBalances(session?.accountId);
  const [panel, setPanel] = useState<Panel>("grid");

  useEffect(() => {
    // Emit funnel completion event when dashboard mounts with active session
    if (session) {
      walletCreationEvents.funnelCompleted({
        network: session.network,
        contractId: session.contractId,
        sessionId: getAnalyticsTracker().hashValue(session.sessionId),
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
      ]}
    >
      {panel === "receive" && session && (
        <div className="max-w-[460px]">
          <ReceiveCard accountId={session.accountId} onClose={() => setPanel("grid")} />
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
        </div>
      )}

      {panel === "grid" && (
        <div className="grid items-start gap-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {/* Account overview */}
          <section className="lpa-panel flex flex-col">
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
                <LpActionButton variant="outline" size="sm" onClick={() => void balances.refetch()}>
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
            </dl>
          </section>

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

          {/* Activity */}
          <section className="lpa-panel min-h-[260px]">
            <Eyebrow>Activity</Eyebrow>
            <div className="lpa-empty mt-6">
              <div className="ph" />
              <p className="max-w-[200px] text-sm!">
                Transaction history arrives with a later wallet-core slice.
              </p>
            </div>
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
