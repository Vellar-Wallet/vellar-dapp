"use client";

import { useState } from "react";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { CopyIcon } from "@/components/icons";

// Receive panel. Shows the smart-account address to fund the wallet; a
// proper QR + SEP-7 URI lands with the receive/QR backlog item.

export function ReceiveCard({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="lpa-panel">
      <div className="flex items-center justify-between">
        <Eyebrow>Receive</Eyebrow>
        <button className="lpa-chip-btn" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      <p className="mt-3! text-sm text-[var(--lp-ink-soft)]">
        Send Stellar assets to this smart-account address.
      </p>
      <div className="lpa-well mt-3">
        <span className="flabel block text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
          YOUR ADDRESS
        </span>
        <p
          data-testid="wallet-address"
          className="mt-1.5! break-all font-[family-name:var(--lp-mono)] text-[13px]"
        >
          {accountId}
        </p>
      </div>
      <LpActionButton
        className="mt-3"
        onClick={() => void navigator.clipboard.writeText(accountId).then(() => setCopied(true))}
      >
        <CopyIcon /> {copied ? "Copied" : "Copy address"}
      </LpActionButton>
    </section>
  );
}
