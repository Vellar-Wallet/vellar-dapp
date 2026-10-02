import type { ReactNode } from "react";
import { LpButton, MonoRow, MonoRows, SectionHead } from "./ui";

/** A listing as the Bazaar shows it: name, price, and a Pay button. */
function BazaarRow({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="lp-rrow">
      <div className="ri"></div>
      <div className="rn">
        <b>{name}</b>
        <span>{meta}</span>
      </div>
      <span className="open">Pay</span>
    </div>
  );
}

/** The three pillars. Each card pairs its explanation with a small example of
 *  the thing it describes, so the section is one set of three cards rather than
 *  three paragraphs followed by three unrelated mock-ups. */
const PILLARS: ReadonlyArray<{
  num: string;
  title: string;
  body: string;
  mock: ReactNode;
}> = [
  {
    num: "01",
    title: "Verify and settle",
    body: "Point your resource server at the Vellar facilitator and it handles the rest: verifying a signed payment, settling it on Stellar, and sponsoring the network fee through a pool of channel accounts. Buyers sign a payment authorization and never hand over keys.",
    mock: (
      <MonoRows>
        <MonoRow label="/verify" value="✓ valid" tone="ok" />
        <MonoRow label="/settle" value="✓ fee sponsored" tone="ok" />
      </MonoRows>
    ),
  },
  {
    num: "02",
    title: "Bazaar discovery",
    body: "A settlement carrying the discovery extension can list your endpoint in the Bazaar, searchable by keyword and semantic ranking. Listing isn't automatic: the settlement has to succeed, and the discovery data, payTo binding and ownership checks all have to pass, so the catalog can't be spammed for free.",
    mock: (
      <div className="lp-rlist">
        <BazaarRow name="Weather API" meta="0.05 USDC" />
        <BazaarRow name="Translate API" meta="0.02 USDC" />
      </div>
    ),
  },
  {
    num: "03",
    title: "Built to be checked",
    body: "The facilitator is open source. Its published testnet settlements, including a canonical conformance run with unmodified clients, resolve independently on the Stellar ledger, so nothing here has to be taken on trust.",
    mock: (
      <MonoRows>
        <MonoRow label="tx hash" value="9a3c…e1f0" />
        <MonoRow label="resource" value="200 OK" tone="ok" />
      </MonoRows>
    ),
  },
];

/** "Building on x402" — the three-pillar facilitator story. */
export function X402Pillars() {
  return (
    <section className="lp-sec lp-ground--paper" id="how">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="Building on x402"
          title={
            <>
              The <em>facilitator</em> for x402 on Stellar.
            </>
          }
          lead={
            <>
              <a href="https://x402.org">x402</a> is the open protocol that turns HTTP 402 into
              machine-payable APIs. Vellar is the piece that sits between a paying agent and a
              seller&apos;s API: it verifies signed payments, settles them on Stellar, and catalogs
              paid endpoints so agents can find them.
            </>
          }
        />
        <div className="lp-pillars" data-reveal-group>
          {PILLARS.map((p) => (
            <div className="lp-pillar" key={p.num}>
              <span className="num">{p.num}</span>
              <h4>{p.title}</h4>
              <p>{p.body}</p>
              <div className="lp-pillar-mock" aria-hidden="true">
                {p.mock}
              </div>
            </div>
          ))}
        </div>

        <div className="lp-cta-row" data-reveal>
          <LpButton href="https://docs.vellar.xyz/docs/getting-started/quickstart" variant="forest">
            Quickstart
          </LpButton>
          <LpButton href="https://github.com/Vellar-Wallet/vellar-facilitator" variant="outline">
            Facilitator on GitHub
          </LpButton>
        </div>
      </div>
    </section>
  );
}
