"use client";

import { useState } from "react";

// Receive panel (design.md §7). Shows the smart-account address to fund the
// wallet; a proper QR + SEP-7 URI lands with the receive/QR backlog item.

export function ReceiveCard({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="neo" style={{ padding: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="eyebrow">Receive</span>
        <button className="pc-dot" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      <p style={{ marginTop: 12, fontSize: 14, color: "var(--muted)" }}>
        Send Stellar assets to this smart-account address.
      </p>
      <div className="neo-inset" style={{ marginTop: 12, padding: "14px 16px" }}>
        <span className="lbl mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
          YOUR ADDRESS
        </span>
        <p className="mono" style={{ marginTop: 6, fontSize: 13, wordBreak: "break-all" }}>
          {accountId}
        </p>
      </div>
      <button
        onClick={() => void navigator.clipboard.writeText(accountId).then(() => setCopied(true))}
        className="btn btn-signal"
        style={{ marginTop: 12 }}
      >
        {copied ? "Copied" : "Copy address"}
      </button>
    </section>
  );
}
