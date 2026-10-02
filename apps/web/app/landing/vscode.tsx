import { Chips, LpButton, SectionHead } from "./ui";

const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402";

/** "VS Code extension" — gate an endpoint with x402 without leaving VS Code. */
export function VsCodeExtension() {
  return (
    <section className="lp-sec lp-ground--ink" id="vscode">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="VS Code extension"
          title={
            <>
              Charge for an API <em>without</em> leaving your VS Code.
            </>
          }
          lead="Vellar x402 scans the open file for a route, asks how much to charge in USDC, and writes the 402 challenge, verification and settlement boilerplate straight into your handler. Nothing else in the file changes."
        />
        <div className="lp-vscode" data-reveal-group>
          <div className="lp-vscode-copy">
            <p>
              Works with Express, Fastify and the Next.js App Router. Pick a route from the command
              palette, set a price, and review real, typed code, ready to install and ship.
            </p>
            <Chips items={[{ label: "Express" }, { label: "Fastify" }, { label: "Next.js" }]} />
            <div className="lp-cta-row">
              <LpButton href={MARKETPLACE_URL} variant="sun">
                Get the extension
              </LpButton>
              <LpButton href="https://docs.vellar.xyz/" variant="outline">
                Read the docs
              </LpButton>
            </div>
          </div>
          <a
            className="lp-vsshot"
            href={MARKETPLACE_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open Vellar x402 on the VS Code Marketplace"
          >
            <div className="lp-vsshot-chrome">
              <i />
              <i />
              <i />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/vscode-extension.png" alt="Vellar x402 listed on the VS Code Marketplace" />
          </a>
        </div>
      </div>
    </section>
  );
}
