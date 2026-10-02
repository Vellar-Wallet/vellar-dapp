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
              Vellar is the open-source payment layer for AI agents on Stellar: verify and settle
              x402 payments, sponsor the fee, and list every paid endpoint in a searchable Bazaar.
            </p>
          </div>
          <div className="lp-foot-cols">
            <div className="lp-foot-col">
              <h4>Product</h4>
              <a href="https://github.com/Vellar-Wallet/vellar-facilitator">Facilitator</a>
              <a href="#bazaar">Bazaar</a>
              <a href="https://playground.vellar.xyz/">Playground</a>
              <a href="https://marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402">
                VS Code extension
              </a>
              <a href="#faq">FAQ</a>
            </div>
            <div className="lp-foot-col">
              <h4>Developers</h4>
              <a href="https://docs.vellar.xyz/">Documentation</a>
              <a href="https://docs.vellar.xyz/docs/getting-started/quickstart">Quickstart</a>
              <a href="https://github.com/Vellar-Wallet/vellar-facilitator">GitHub</a>
            </div>
            <div className="lp-foot-col">
              <h4>Company</h4>
              <Link href="/about">About</Link>
              <a href="mailto:hello@vellar.xyz">Contact</a>
            </div>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" aria-hidden className="lp-foot-logo" />
        <div className="lp-foot-bot">
          <span>© 2026 Vellar · Built on Stellar</span>
          <span>open source · non-custodial · x402</span>
        </div>
      </div>
    </footer>
  );
}
