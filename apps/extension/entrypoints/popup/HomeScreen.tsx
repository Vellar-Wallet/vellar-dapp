import { useEffect, useState } from "react";
import type { PermissionGrant } from "@vellar/provider-sdk";
import type { ExtensionState, PairedWallet } from "../../lib/state";
import { monogram } from "./ApprovalScreen";

// Popup home (design.md §8): a flat 360×600 frame — header, balance header,
// three quick actions, connected dApps. High-frequency actions live here;
// advanced workflows deep-link to the web app (technical-doc.md §4.2).

const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

/** Quick balance summary (§4.2 "quick access to balances"). Best-effort:
 * `undefined` while loading, `null` when the read failed. */
function useQuickBalance(wallet: PairedWallet | undefined) {
  const [balance, setBalance] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setBalance(undefined);
    void (async () => {
      try {
        const [{ formatTokenAmount }, { createRpcBalanceReader, nativeToken }] = await Promise.all([
          import("vellar-sdk/balances"),
          import("vellar-sdk/rpc"),
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

function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const ICON = {
  send: "M7 17L17 7M9 7h8v8",
  receive: "M17 7L7 17M15 17H7V9",
  check: "M5 12l5 5L20 7",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
};

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function Header({ wallet }: { wallet: PairedWallet | undefined }) {
  return (
    <header className="frame-head">
      <img className="brand" src="/logo-mark.png" alt="Vellar" />
      {wallet && <span className={`net ${wallet.network}`}>{wallet.network}</span>}
    </header>
  );
}

function Unpaired() {
  return (
    <main className="frame">
      <Header wallet={undefined} />
      <div className="frame-body">
        <section className="unpaired">
          <span className="eyebrow">Not paired</span>
          <h1>Connect your wallet</h1>
          <p>Pair this extension with your Vellar smart account to approve dApps from here.</p>
          <ol className="steps">
            <li>Open the Vellar web app and sign in</li>
            <li>Go to Settings → Pair extension</li>
            <li>Confirm with your passkey</li>
          </ol>
        </section>
      </div>
    </main>
  );
}

export function HomeScreen({
  state,
  onRevoke,
}: {
  state: ExtensionState | null;
  onRevoke: (grant: PermissionGrant) => void;
}) {
  const wallet = state?.pairedWallet;
  const balance = useQuickBalance(wallet);
  const [copied, setCopied] = useState(false);

  if (!wallet) return <Unpaired />;

  const app = wallet.webAppOrigin;
  const grants = state?.grants ?? [];

  function copyAddress() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function openApp(path: string) {
    if (app) window.open(`${app}${path}`, "_blank", "noreferrer");
  }

  return (
    <main className="frame">
      <Header wallet={wallet} />

      <div className="frame-body">
        <section className="balance-head" aria-label="Balance">
          <span className="eyebrow">Balance</span>
          <p className={balance === undefined ? "amount loading" : "amount"}>
            {balance ?? "—"}
            <small>XLM</small>
          </p>
          <button className="acct" onClick={copyAddress} title={wallet.address}>
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-6)}
            <span aria-live="polite">{copied ? "· Copied" : ""}</span>
          </button>

          <div className="actions">
            <button className="action" disabled={!app} onClick={() => openApp("/dashboard")}>
              <span className="glyph">
                <Glyph d={ICON.send} />
              </span>
              Send
            </button>
            <button className="action" onClick={copyAddress}>
              <span className="glyph">
                <Glyph d={copied ? ICON.check : ICON.receive} />
              </span>
              {copied ? "Copied" : "Receive"}
            </button>
            <button className="action" disabled={!app} onClick={() => openApp("/dashboard")}>
              <span className="glyph">
                <Glyph d={ICON.open} />
              </span>
              Open app
            </button>
          </div>
        </section>

        <section className="section" aria-label="Connected dApps">
          <div className="section-head">
            <span className="eyebrow">Connected dApps</span>
            {grants.length > 0 && <span className="count">{grants.length}</span>}
          </div>
          {grants.length === 0 ? (
            <p className="empty">No sites connected. dApps you approve will appear here.</p>
          ) : (
            grants.map((grant) => (
              <div key={`${grant.origin}-${grant.network}`} className="row">
                <div className="mono-mark" aria-hidden>
                  {monogram(grant.origin)}
                </div>
                <div className="grow">
                  <p className="title" title={grant.origin}>
                    {hostOf(grant.origin)}
                  </p>
                  <p className="sub">{grant.network}</p>
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => onRevoke(grant)}>
                  Revoke
                </button>
              </div>
            ))
          )}
        </section>

        {app && (
          <section className="section" style={{ textAlign: "center" }}>
            <a className="link" href={`${app}/dashboard`} target="_blank" rel="noreferrer">
              Payments, policies &amp; settings in the web app →
            </a>
          </section>
        )}
      </div>
    </main>
  );
}
