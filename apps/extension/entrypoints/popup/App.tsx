import "../../lib/buffer-polyfill";
import "./popup.css";
import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { browserKv } from "../../lib/browser-kv";
import type { PendingApprovalSummary } from "../../lib/messages";
import { loadState, revokeGrant, type ExtensionState, type PairedWallet } from "../../lib/state";
import { formatStroops, summarizeTransaction, type TransactionSummary } from "../../lib/tx-summary";

const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

/** Quick balance summary (§4.2 "quick access to balances"). Best-effort. */
function useQuickBalance(wallet: PairedWallet | undefined) {
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ formatTokenAmount }, { createRpcBalanceReader, nativeToken }] = await Promise.all([
          import("@vela/wallet-sdk/balances"),
          import("@vela/wallet-sdk/rpc"),
        ]);
        const passphrase = NETWORK_PASSPHRASES[wallet.network];
        const token = nativeToken(passphrase);
        const reader = createRpcBalanceReader({
          rpcUrl: wallet.rpcUrl,
          networkPassphrase: passphrase,
        });
        const amount = await reader.getTokenBalance(token.contractId, wallet.address);
        if (!cancelled) setBalance(formatTokenAmount(amount, token.decimals));
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  return balance;
}

// Popup (technical-doc.md §4.2, §7.3; design.md §8): dark neomorphic at popup
// density. Approval prompts show the requesting origin ALWAYS (§8.2); quick
// account view + per-origin permissions; advanced workflows deep-link out.

interface RequestDescription {
  text: string;
  /** Long identifier shown on its own wrapping line (e.g. a wallet address). */
  address?: string;
}

function describeRequest(request: PendingApprovalSummary["request"]): RequestDescription {
  switch (request.method) {
    case "connect":
      return { text: "wants to connect: see your address and request transaction approvals." };
    case "pair":
      return {
        text: `wants to pair this extension as a device signer on ${request.params.network}. You'll confirm with your passkey next; the pairing expires automatically.`,
        address: request.params.address,
      };
    case "sign_transaction":
      return {
        text: `wants you to sign a transaction on ${request.params.network}. Approving signs it with this device's key — review the site carefully.`,
      };
    default:
      return { text: `sent a ${request.method} request.` };
  }
}

/** Decode a sign_transaction request into a review summary (§8.2 — the user
 * must see WHAT they sign). stellar-sdk is loaded lazily so the popup stays
 * light; a decode failure yields a safe generic summary, never a throw. */
function useTxSummary(approval: PendingApprovalSummary): TransactionSummary | null {
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const request = approval.request;
  useEffect(() => {
    if (request.method !== "sign_transaction") {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { TransactionBuilder, Address, scValToNative } = await import("@stellar/stellar-sdk");
      const result = summarizeTransaction(request.params.xdr, request.params.network, {
        TransactionBuilder,
        Address,
        scValToNative,
      });
      if (!cancelled) setSummary(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);
  return summary;
}

function OperationLine({ op }: { op: TransactionSummary["operations"][number] }) {
  if (op.kind === "transfer") {
    return (
      <p className="mono" style={{ margin: "4px 0 0", fontSize: 11, wordBreak: "break-all" }}>
        transfer <strong>{formatStroops(op.amount)}</strong> → {op.to.slice(0, 6)}…{op.to.slice(-6)}
      </p>
    );
  }
  if (op.kind === "contract-call") {
    return (
      <p className="mono" style={{ margin: "4px 0 0", fontSize: 11, wordBreak: "break-all" }}>
        call <strong>{op.fn}</strong> on {op.contract.slice(0, 6)}…{op.contract.slice(-6)}
      </p>
    );
  }
  return (
    <p className="mono" style={{ margin: "4px 0 0", fontSize: 11 }}>
      {op.label}
    </p>
  );
}

function ApprovalCard({
  approval,
  onResolved,
}: {
  approval: PendingApprovalSummary;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isSign = approval.request.method === "sign_transaction";
  const desc = describeRequest(approval.request);
  const summary = useTxSummary(approval);

  async function resolve(approved: boolean) {
    setBusy(true);
    await browser.runtime.sendMessage({ type: "resolve-pending", id: approval.id, approved });
    onResolved();
  }

  return (
    <section className="neo" aria-label="Connection request">
      <span className="eyebrow">Request from</span>
      <p className="origin">{approval.origin}</p>
      <span className="trust">{isSign ? "⚠ Signature request" : "✓ Connection request"}</span>
      <p className="muted" style={{ fontSize: 13, margin: "10px 0 0", lineHeight: 1.5 }}>
        {desc.text}
      </p>
      {desc.address && (
        <div className="neo-inset" style={{ marginTop: 8 }}>
          <span className="eyebrow" style={{ fontSize: 9 }}>
            Wallet
          </span>
          <p className="mono" style={{ margin: "4px 0 0", fontSize: 11, wordBreak: "break-all" }}>
            {desc.address}
          </p>
        </div>
      )}

      {isSign && summary && (
        <div className="neo-inset" style={{ marginTop: 8 }}>
          <span className="eyebrow" style={{ fontSize: 9 }}>
            {summary.undecoded ? "Transaction" : "This transaction will"}
          </span>
          {summary.operations.map((op, i) => (
            <OperationLine key={i} op={op} />
          ))}
          {summary.movesValue && (
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 11, lineHeight: 1.45 }}>
              This moves value. Any spending-limit policy on your account applies to this device and
              can reject or cap it on-chain — review your policies in the VELA app.
            </p>
          )}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn btn-signal" disabled={busy} onClick={() => void resolve(true)}>
          Approve
        </button>
        <button className="btn btn-neo" disabled={busy} onClick={() => void resolve(false)}>
          Reject
        </button>
      </div>
    </section>
  );
}

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [copied, setCopied] = useState(false);
  const wallet = state?.pairedWallet;
  const balance = useQuickBalance(wallet);

  const refresh = useCallback(async () => {
    setState(await loadState(browserKv));
    const pending = (await browser.runtime.sendMessage({
      type: "list-pending",
    })) as PendingApprovalSummary[];
    setApprovals(pending ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isApprovalWindow = new URLSearchParams(window.location.search).has("approval");

  async function onResolved() {
    await refresh();
    const remaining = (await browser.runtime.sendMessage({
      type: "list-pending",
    })) as PendingApprovalSummary[];
    if (isApprovalWindow && (remaining ?? []).length === 0) window.close();
  }

  async function revoke(origin: string, network: string) {
    await revokeGrant(browserKv, origin, network);
    await refresh();
  }

  function copyAddress() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <main className="pop">
      <div className="topbar">
        <img className="brand" src="/logo-light.png" alt="VELA" />
        {wallet && (
          <span className="netpill">
            <span className="dot" /> {wallet.network}
          </span>
        )}
      </div>

      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onResolved={() => void onResolved()} />
      ))}

      {wallet ? (
        <>
          <section className="neo">
            <div style={{ textAlign: "center" }}>
              <span className="eyebrow">Balance</span>
            </div>
            <div className="bal">
              {balance ?? "—"} <small>XLM</small>
            </div>
            <div className="qa">
              <button onClick={copyAddress}>
                <i>{copied ? "✓" : "⧉"}</i>
                {copied ? "Copied" : "Address"}
              </button>
              {wallet.webAppOrigin && (
                <button onClick={() => window.open(`${wallet.webAppOrigin}/dashboard`, "_blank")}>
                  <i>↑</i>Send
                </button>
              )}
            </div>
          </section>

          <div className="neo-inset">
            <span className="eyebrow">Smart account</span>
            <p className="mono" style={{ margin: "6px 0 0", fontSize: 11, wordBreak: "break-all" }}>
              {wallet.address}
            </p>
          </div>

          {wallet.webAppOrigin && (
            <a
              className="link"
              href={`${wallet.webAppOrigin}/dashboard`}
              target="_blank"
              rel="noreferrer"
              style={{ textAlign: "center" }}
            >
              Open web app for payments, policies &amp; settings →
            </a>
          )}
        </>
      ) : (
        <section className="neo">
          <span className="eyebrow">Not paired</span>
          <p className="muted" style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.55 }}>
            Open the VELA web app, sign in, and choose Settings → Pair extension to get started.
          </p>
        </section>
      )}

      {state && state.grants.length > 0 && (
        <section className="neo" aria-label="Connected dApps">
          <span className="eyebrow">Connected dApps</span>
          <div style={{ marginTop: 4 }}>
            {state.grants.map((grant) => (
              <div key={`${grant.origin}-${grant.network}`} className="dapp">
                <span style={{ wordBreak: "break-all" }}>{grant.origin}</span>
                <button
                  className="btn btn-neo"
                  style={{ padding: "6px 12px", fontSize: 12 }}
                  onClick={() => void revoke(grant.origin, grant.network)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
