import Link from "next/link";

/** Site footer for all .lp marketing pages: link columns, the faint
 *  stretched wordmark watermark, and the legal row. */
export function LpFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-foot-top">
          <div className="lp-foot-brand">
            <p>
              The agent-payments stack for Stellar, built on x402, with passkey smart wallets,
              programmable policies and trust signals, for people and their agents.
            </p>
          </div>
          <div className="lp-foot-cols">
            <div className="lp-foot-col">
              <h4>Product</h4>
              <Link href="/app">Wallet</Link>
              <a href="#extension">Extension</a>
              <a href="#agents">Agent payments</a>
              <a href="#faq">FAQ</a>
            </div>
            <div className="lp-foot-col">
              <h4>Developers</h4>
              <a href="https://docs.vellar.xyz/">Documentation</a>
              <a href="https://docs.vellar.xyz/docs/getting-started/quickstart">Quickstart</a>
              <a href="https://docs.vellar.xyz/docs/api-reference">SDK reference</a>
              <a href="https://github.com/Vellar-Wallet/vellar-sdk">GitHub</a>
            </div>
            <div className="lp-foot-col">
              <h4>Company</h4>
              <Link href="/about">About</Link>
              <a href="https://docs.vellar.xyz/docs/security">Security</a>
              <a href="mailto:hello@vellar.xyz">Contact</a>
            </div>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" aria-hidden className="lp-foot-logo" />
        <div className="lp-foot-bot">
          <span>© 2026 Vellar · Built on Stellar</span>
          <span>passkeys · policies · trust · agents</span>
        </div>
      </div>
    </footer>
  );
}
