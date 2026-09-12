"use client";

import { useState } from "react";
import { useConnectedWallet } from "../../lib/connected-wallet-context";
import { marketplaceApiUrl } from "../../lib/config";
import { connectedWalletErrorMessage } from "@vellar/provider-sdk/connected-wallet";

// The full payment flow — new-build-technical-doc.md §4.5, §7.2. Deliberately
// does NOT use WalletRequired: that gate REPLACES its children when
// disconnected, but here the button itself must still render (as a "Connect
// to Pay" prompt) rather than disappear.

type PayState =
  | { phase: "idle" }
  | { phase: "quoting" }
  | { phase: "confirming"; price: string | null; asset: string | null }
  | { phase: "paying" }
  | { phase: "success"; txHash: string }
  | { phase: "error"; message: string };

interface QuoteResponse {
  free: boolean;
  price: string | number | null;
  asset: string | null;
}

interface PayResponse {
  content: string | null;
  txHash: string | null;
  ledger: number | null;
  amountPaid: string | null;
  asset: string | null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function PayButton({
  resourceUrl,
  priceAtomic,
}: {
  resourceUrl: string;
  priceAtomic?: string;
}) {
  const { isConnected, address, connect, signTransaction } = useConnectedWallet();
  const [state, setState] = useState<PayState>({ phase: "idle" });

  if (!isConnected || !address) {
    return (
      <button type="button" className="lp-btn lp-btn--sun lp-btn--sm" onClick={() => void connect()}>
        Connect to Pay
      </button>
    );
  }

  async function requestQuote() {
    setState({ phase: "quoting" });
    try {
      const res = await fetch(`${marketplaceApiUrl()}/payments/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceUrl, walletAddress: address }),
      });
      const body = (await readJson(res)) as Partial<QuoteResponse> & { message?: string };
      if (!res.ok) {
        setState({ phase: "error", message: body.message ?? "Could not fetch a quote" });
        return;
      }
      setState({
        phase: "confirming",
        price: body.price === null || body.price === undefined ? null : String(body.price),
        asset: body.asset ?? null,
      });
    } catch (err) {
      setState({
        phase: "error",
        message: connectedWalletErrorMessage(err, "Could not reach the marketplace"),
      });
    }
  }

  async function confirmPay() {
    setState({ phase: "paying" });
    try {
      // TODO(step-4): this is a PLACEHOLDER. The real flow builds a Stellar
      // transaction encoding the x402 payment authorization (the exact shape
      // depends on what the resource's 402 challenge asked for) and signs
      // THAT. Signing a literal string lets us verify the UI state machine —
      // connect → quote → confirm → pay → success/error — end to end before
      // wiring real transaction construction. The backend's signature check
      // (lib/signature.ts) will correctly reject this XDR; expect a 401/400
      // here until step 4 replaces it.
      const signedXdr = await signTransaction("placeholder");
      const res = await fetch(`${marketplaceApiUrl()}/payments/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceUrl,
          signedXdr,
          walletAddress: address,
          maxAmount: priceAtomic ?? "0",
        }),
      });
      const body = (await readJson(res)) as Partial<PayResponse> & { message?: string };
      if (!res.ok) {
        setState({ phase: "error", message: body.message ?? "Payment failed" });
        return;
      }
      setState({ phase: "success", txHash: body.txHash ?? "" });
      setTimeout(() => setState({ phase: "idle" }), 3000);
    } catch (err) {
      setState({
        phase: "error",
        message: connectedWalletErrorMessage(err, "Payment failed"),
      });
    }
  }

  if (state.phase === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-2)" }}>
        <button type="button" className="lp-btn lp-btn--sun lp-btn--sm" onClick={() => void requestQuote()}>
          Pay
        </button>
        <div className="lp-mkt-error">
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  if (state.phase === "success") {
    const short = state.txHash ? `${state.txHash.slice(0, 6)}...${state.txHash.slice(-4)}` : "";
    return (
      <span className="lp-verified">
        Paid{short && ` · ${short}`}
      </span>
    );
  }

  if (state.phase === "paying") {
    return (
      <button type="button" disabled className="lp-btn lp-btn--sun lp-btn--sm" style={{ opacity: 0.6 }}>
        Paying...
      </button>
    );
  }

  if (state.phase === "confirming") {
    const priceLabel = state.price !== null ? `${state.price} ${state.asset ?? ""}`.trim() : "price";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "var(--lp-sp-2)" }}>
        <span style={{ fontFamily: "var(--lp-mono)", fontSize: "var(--lp-fs-sm)", color: "var(--lp-ink)" }}>
          {priceLabel}
        </span>
        <button type="button" className="lp-btn lp-btn--sun lp-btn--sm" onClick={() => void confirmPay()}>
          Confirm
        </button>
        <button
          type="button"
          className="lp-btn lp-btn--ghost lp-btn--sm"
          onClick={() => setState({ phase: "idle" })}
        >
          Cancel
        </button>
      </div>
    );
  }

  const busy = state.phase === "quoting";
  return (
    <button
      type="button"
      disabled={busy}
      className="lp-btn lp-btn--sun lp-btn--sm"
      style={busy ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
      onClick={() => void requestQuote()}
    >
      {busy ? "Loading..." : "Pay"}
    </button>
  );
}
