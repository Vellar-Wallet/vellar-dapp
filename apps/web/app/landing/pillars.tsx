import { LpButton, SectionHead } from "./ui";

/** The three pillars: one set of three cards. */
const PILLARS = [
  {
    num: "01",
    title: "Verify and settle",
    body: "Point your resource server at the Vellar facilitator and it handles the rest: verifying a signed payment, settling it on Stellar, and sponsoring the network fee through a pool of channel accounts. Buyers sign a payment authorization and never hand over keys.",
  },
  {
    num: "02",
    title: "Bazaar discovery",
    body: "A settlement carrying the discovery extension can list your endpoint in the Bazaar, searchable by keyword and semantic ranking. Listing isn't automatic: the settlement has to succeed, and the discovery data, payTo binding and ownership checks all have to pass, so the catalog can't be spammed for free.",
  },
  {
    num: "03",
    title: "Built to be checked",
    body: "The facilitator is open source. Its published testnet settlements, including a canonical conformance run with unmodified clients, resolve independently on the Stellar ledger, so nothing here has to be taken on trust.",
  },
] as const;

/** "Building on x402" — the three-pillar facilitator story. */
export function X402Pillars() {
  return (
    <section className="lp-sec lp-ground--paper" id="how">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="Building on x402"
          title={
            <>
              What the <em>payment layer</em> does.
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
