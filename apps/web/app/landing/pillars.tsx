import { Chips, Field, Frame, LpButton, MonoRow, MonoRows, SectionHead, TokenPill } from "./ui";

const BAZAAR = [
  { name: "Weather API", meta: "0.05 USDC" },
  { name: "Translate API", meta: "0.02 USDC" },
  { name: "GPU Inference", meta: "0.25 USDC" },
];

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
];

/** "Building on x402" — the three-pillar facilitator story, followed by
 *  the three product mock cards (seller, facilitator, Bazaar).
 *
 *  The cards moved here from the hero when the hero became a 100vh
 *  sticky scene: they are the concrete illustration of the three pillars
 *  above them, so they read better here than under a poster headline. */
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
            </div>
          ))}
        </div>

        <div className="lp-hero-cards" data-reveal-group>
          <Frame>
            <div className="lp-pcard">
              <div className="lp-pcard-top">
                <span>Seller · Example</span>
                <span>◇</span>
              </div>
              <Field
                label="GET /v1/research"
                amount="402"
                amountStyle={{ fontSize: 18 }}
                sub={
                  <>
                    <span>price 0.05 USDC</span>
                    <span>scheme exact</span>
                  </>
                }
              />
              <Field
                label="NETWORK"
                amount="stellar:pubnet"
                token={<TokenPill usdc label="USDC" />}
                sub={<span>Payment Required</span>}
              />
              <Chips
                items={[
                  { label: "exact", on: true },
                  { label: "upto" },
                  { label: "Bazaar-listed" },
                ]}
              />
            </div>
          </Frame>

          <Frame corner="tr" color="sun">
            <div className="lp-pcard">
              <div className="lp-pcard-top">
                <span>Facilitator</span>
                <span>⚡</span>
              </div>
              <MonoRows>
                <MonoRow label="/verify" value="✓ valid" tone="ok" />
                <MonoRow label="/settle" value="✓ fee sponsored" tone="ok" />
                <MonoRow label="tx hash" value="9a3c…e1f0" />
                <MonoRow label="resource" value="200 OK" tone="ok" />
              </MonoRows>
            </div>
          </Frame>

          <Frame corner="br" color="lime">
            <div className="lp-pcard">
              <div className="lp-pcard-top">
                <span>Bazaar · Example</span>
                <span>◎</span>
              </div>
              <span className="lp-verified">Searchable catalog</span>
              <div className="lp-rlist">
                {BAZAAR.map((r) => (
                  <div className="lp-rrow" key={r.name}>
                    <div className="ri"></div>
                    <div className="rn">
                      <b>{r.name}</b>
                      <span>{r.meta}</span>
                    </div>
                    <span className="open">Pay</span>
                  </div>
                ))}
              </div>
            </div>
          </Frame>
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
