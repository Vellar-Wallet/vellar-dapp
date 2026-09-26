import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { TrustBadge } from "@vellar/ui";
import type { VerificationStatus } from "@vellar/verification-sdk";
import type { PendingApprovalSummary } from "../../lib/messages";
import type { PairedWallet } from "../../lib/state";
import { sanitizeString } from "../../lib/sanitization";
import { formatStroops, summarizeTransaction, type TransactionSummary } from "../../lib/tx-summary";
import { verificationClient } from "../../lib/verification";

// Connect / approve dApp screen (design.md §8, technical-doc.md §8.2): a
// full-frame takeover led by a trust-signal hero. The requesting origin is
// ALWAYS shown — hostname large, full origin beneath — so a lookalike domain
// can't hide behind a friendly name. Actions stay pinned in the footer.

type Method = PendingApprovalSummary["request"]["method"];

const SIGN_METHODS: ReadonlySet<Method> = new Set([
  "sign_transaction",
  "sign_auth_entry",
  "sign_message",
]);

const APPROVE_LABEL: Partial<Record<Method, string>> = {
  connect: "Connect",
  pair: "Pair",
  sign_transaction: "Sign",
  sign_auth_entry: "Sign",
  sign_message: "Sign",
};

function parseOrigin(origin: string): { host: string; secure: boolean } {
  try {
    const url = new URL(origin);
    const secure =
      url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return { host: url.host, secure };
  } catch {
    return { host: origin, secure: false };
  }
}

export function monogram(origin: string): string {
  const { host } = parseOrigin(origin);
  const bare = host.replace(/^www\./, "");
  return (bare.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}

interface RequestCopy {
  title: string;
  ask: string;
  /** Long identifier shown on its own wrapping line (e.g. a wallet address). */
  address?: string;
}

function describeRequest(request: PendingApprovalSummary["request"]): RequestCopy {
  switch (request.method) {
    case "connect":
      return {
        title: "Connect",
        ask: "wants to connect to your Vellar wallet.",
      };
    case "pair":
      return {
        title: "Pair device",
        ask: `wants to pair this extension as a device signer on ${sanitizeString(request.params.network)}. You'll confirm with your passkey next; the pairing expires automatically.`,
        address: sanitizeString(request.params.address),
      };
    case "sign_transaction":
      return {
        title: "Sign transaction",
        ask: `wants you to sign a transaction on ${sanitizeString(request.params.network)}. Approving signs it with this device's key.`,
      };
    case "sign_auth_entry":
      return {
        title: "Sign authorization",
        ask: `wants you to sign a Soroban authorization entry on ${sanitizeString(request.params.network)}. Approving signs it with this device's key.`,
      };
    case "sign_message":
      return {
        title: "Sign message",
        ask: `wants you to sign an off-chain message on ${sanitizeString(request.params.network)}. Approving signs it with this device's key.`,
      };
    default:
      return {
        title: "Request",
        ask: `sent a ${sanitizeString((request as { method: string }).method)} request.`,
      };
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

/** Trust signal for a contract a transaction will call (§5.5). Best-effort: a
 * lookup failure yields "unverified" so the badge degrades to neutral rather
 * than blocking the review. */
function useContractTrust(contractId: string | undefined): VerificationStatus {
  const [status, setStatus] = useState<VerificationStatus>("unverified");
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await verificationClient().getStatus(contractId);
        if (!cancelled) setStatus(result.status);
      } catch {
        if (!cancelled) setStatus("unverified");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contractId]);
  return status;
}

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-6)}`;

function OperationLine({ op }: { op: TransactionSummary["operations"][number] }) {
  const contractId = op.kind === "contract-call" ? op.contract : undefined;
  const trust = useContractTrust(contractId);

  if (op.kind === "transfer") {
    return (
      <div className="op">
        <span className="verb">Send</span>
        <p className="what">
          <strong>{formatStroops(op.amount)}</strong> → {short(op.to)}
        </p>
      </div>
    );
  }
  if (op.kind === "contract-call") {
    return (
      <div className="op">
        <span className="verb">Call contract</span>
        <p className="what">
          <strong>{op.fn}</strong> on {short(op.contract)}
        </p>
        <div className="badge">
          <TrustBadge status={trust} size="sm" />
        </div>
      </div>
    );
  }
  return (
    <div className="op">
      <span className="verb">Operation</span>
      <p className="what">{op.label}</p>
    </div>
  );
}

function ConnectPermissions() {
  return (
    <ul className="perms">
      <li>
        <span className="tick">✓</span>
        See your smart-account address and network
      </li>
      <li>
        <span className="tick">✓</span>
        Ask you to approve transactions
      </li>
      <li className="deny">
        <span className="tick">✕</span>
        Move funds or sign anything without your approval
      </li>
    </ul>
  );
}

export function ApprovalScreen({
  approval,
  position,
  total,
  wallet,
  onResolved,
}: {
  approval: PendingApprovalSummary;
  position: number;
  total: number;
  wallet: PairedWallet | undefined;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { host, secure } = parseOrigin(approval.origin);
  const isSign = SIGN_METHODS.has(approval.request.method);
  const copy = describeRequest(approval.request);
  const summary = useTxSummary(approval);

  // A new approval in the queue must not inherit the previous one's busy lock.
  useEffect(() => setBusy(false), [approval.id]);

  async function resolve(approved: boolean) {
    setBusy(true);
    await browser.runtime.sendMessage({ type: "resolve-pending", id: approval.id, approved });
    onResolved();
  }

  return (
    <main className="frame" aria-label={`${copy.title} request from ${approval.origin}`}>
      <header className="frame-head">
        <img className="brand" src="/logo-mark.png" alt="Vellar" />
        <div className="right">
          {total > 1 && (
            <span className="queue">
              {position} of {total}
            </span>
          )}
          {wallet && <span className={`net ${wallet.network}`}>{wallet.network}</span>}
        </div>
      </header>

      <div className="frame-body">
        <section className={isSign ? "hero sign" : "hero"}>
          <div className="mono-mark" aria-hidden>
            {monogram(approval.origin)}
          </div>
          <p className="host">{host}</p>
          <p className="full-origin">{approval.origin}</p>
          <div className="signals">
            <span className={isSign ? "signal warn" : "signal"}>
              {isSign ? "⚠" : "✓"} {copy.title}
            </span>
            <span className={secure ? "signal" : "signal bad"}>
              {secure ? "🔒 Secure origin" : "⚠ Not HTTPS"}
            </span>
          </div>
          <p className="ask">
            <strong>{host}</strong> {copy.ask}
          </p>
        </section>

        {approval.request.method === "connect" && (
          <section className="section">
            <div className="section-head">
              <span className="eyebrow">This site will be able to</span>
            </div>
            <ConnectPermissions />
          </section>
        )}

        {(copy.address ?? wallet?.address) && (
          <section className="section">
            <div className="section-head">
              <span className="eyebrow">{copy.address ? "Wallet to pair" : "Account"}</span>
            </div>
            <p className="mono" style={{ margin: 0, fontSize: 11, wordBreak: "break-all" }}>
              {copy.address ?? wallet?.address}
            </p>
          </section>
        )}

        {isSign && summary && (
          <section className="section">
            <div className="section-head">
              <span className="eyebrow">
                {summary.undecoded ? "Transaction" : "This transaction will"}
              </span>
              <span className="count">{summary.operations.length} op</span>
            </div>
            {summary.operations.map((op, i) => (
              <OperationLine key={i} op={op} />
            ))}
            {summary.movesValue && (
              <div className="callout">
                This moves value. Any spending-limit policy on your account applies to this device
                and can reject or cap it on-chain — review your policies in the Vellar app.
              </div>
            )}
          </section>
        )}
      </div>

      <footer className="frame-foot">
        <p className="note">Only approve requests from sites you trust.</p>
        <div className="btn-row">
          <button className="btn btn-outline" disabled={busy} onClick={() => void resolve(false)}>
            Reject
          </button>
          <button className="btn btn-sun" disabled={busy} onClick={() => void resolve(true)}>
            {APPROVE_LABEL[approval.request.method] ?? "Approve"}
          </button>
        </div>
      </footer>
    </main>
  );
}
