"use client";

import { useState } from "react";
import { formatTokenAmount } from "@vela/wallet-sdk";
import { AppShell } from "@/components/app-shell";
import { useBalances } from "@/lib/balances";
import { useWalletSession } from "@/lib/wallet-context";
import { ReceiveCard } from "./receive-card";
import { SendPayment } from "./send-payment";

// Wallet dashboard (docs/decisions.md dark-neomorphic shell): panel grid —
// Account overview (balance + details) · My assets · Activity. Send/Receive
// open as focused panels replacing the grid.

type Panel = "grid" | "send" | "receive";

export default function Dashboard() {
  const session = useWalletSession();
  const balances = useBalances(session?.accountId);
  const [panel, setPanel] = useState<Panel>("grid");

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
        <div style={{ maxWidth: 460 }}>
          <ReceiveCard accountId={session.accountId} onClose={() => setPanel("grid")} />
        </div>
      )}

      {panel === "send" && session && (
        <div style={{ maxWidth: 460 }}>
          <button
            onClick={() => setPanel("grid")}
            className="mono"
            style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 14, display: "block" }}
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
            <section className="neo" style={{ padding: 22 }}>
              <span className="eyebrow">Send</span>
              <p style={{ marginTop: 12, fontSize: 14, color: "var(--muted)" }}>
                Fund the wallet first — receive some XLM, then come back to send.
              </p>
            </section>
          )}
        </div>
      )}

      {panel === "grid" && (
        <div
          className="panel-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 22,
            alignItems: "start",
          }}
        >
          {/* Account overview */}
          <section
            className="neo"
            style={{ padding: 24, display: "flex", flexDirection: "column" }}
          >
            <span className="eyebrow">Account balance</span>
            <div className="display" style={{ fontSize: 44, marginTop: 10 }}>
              {balances.isPending ? (
                <span className="animate-pulse" style={{ color: "var(--muted2)" }}>
                  …
                </span>
              ) : (
                <>
                  {total} <span style={{ fontSize: 18, color: "var(--muted2)" }}>XLM</span>
                </>
              )}
            </div>

            {Boolean(balances.error) && (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <span role="alert" style={{ fontSize: 13, color: "var(--negative)" }}>
                  Couldn&apos;t load balances.
                </span>
                <button
                  onClick={() => void balances.refetch()}
                  className="neo-btn"
                  style={{ padding: "6px 14px", fontSize: 13 }}
                >
                  Retry
                </button>
              </div>
            )}

            <dl style={{ marginTop: 24, display: "flex", flexDirection: "column" }}>
              <DetailRow label="Account name" value={session?.accountId.slice(-8) ?? ""} />
              <DetailRow
                label="Public key"
                value={
                  session ? `${session.accountId.slice(0, 6)}…${session.accountId.slice(-6)}` : ""
                }
                mono
              />
              <DetailRow label="Network" value={session?.network ?? ""} />
              <DetailRow label="Auth method" value="Passkey" last />
            </dl>
          </section>

          {/* My assets */}
          <section className="neo" style={{ padding: 24, minHeight: 260 }}>
            <span className="eyebrow">My assets</span>
            {balances.isPending && (
              <p
                className="animate-pulse"
                style={{ marginTop: 14, fontSize: 14, color: "var(--muted2)" }}
              >
                Loading…
              </p>
            )}
            {balances.data?.length ? (
              <div style={{ marginTop: 6 }}>
                {balances.data.map((b) => (
                  <div key={b.contractId} className="tokrow">
                    <div className="ti"></div>
                    <div className="tn">
                      <b>{b.symbol === "XLM" ? "Stellar Lumens" : b.symbol}</b>
                      <span>{b.symbol}</span>
                    </div>
                    <div className="tv">
                      <b className="display" style={{ fontSize: 16 }}>
                        {formatTokenAmount(b.amount, b.decimals)}
                      </b>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              !balances.isPending && (
                <div
                  style={{
                    marginTop: 24,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    color: "var(--muted2)",
                  }}
                >
                  <div
                    className="neo-inset"
                    style={{ width: 72, height: 72, borderRadius: "50%" }}
                  />
                  <p style={{ fontSize: 14 }}>No assets yet</p>
                  <button
                    onClick={() => setPanel("receive")}
                    className="neo-btn"
                    style={{ padding: "8px 18px", fontSize: 13, fontWeight: 700 }}
                  >
                    Receive assets
                  </button>
                </div>
              )
            )}
          </section>

          {/* Activity */}
          <section className="neo" style={{ padding: 24, minHeight: 260 }}>
            <span className="eyebrow">Activity</span>
            <div
              style={{
                marginTop: 24,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
                color: "var(--muted2)",
              }}
            >
              <div className="neo-inset" style={{ width: 72, height: 72, borderRadius: "50%" }} />
              <p style={{ fontSize: 14, textAlign: "center", maxWidth: 200 }}>
                Transaction history arrives with a later wallet-core slice.
              </p>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

function DetailRow({
  label,
  value,
  mono,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 0",
        borderBottom: last ? "none" : "1px solid var(--line)",
        fontSize: 14,
      }}
    >
      <dt style={{ color: "var(--muted2)" }}>{label}</dt>
      <dd
        className={mono ? "mono" : undefined}
        style={{ textTransform: mono ? "none" : "capitalize" }}
      >
        {value}
      </dd>
    </div>
  );
}
