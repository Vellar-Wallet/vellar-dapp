import { Chips, Field, Frame, LpButton, MonoRow, MonoRows, TokenPill } from "./ui";
import { HeroWaves } from "./hero-waves";

const BAZAAR = [
  { name: "Weather API", meta: "0.05 USDC" },
  { name: "Translate API", meta: "0.02 USDC" },
  { name: "GPU Inference", meta: "0.25 USDC" },
];

/** Landing hero: the statement headline plus the three mock cards
 *  (seller, facilitator, Bazaar). */
export function Hero() {
  return (
    <header className="lp-hero">
      <HeroWaves />
      <div className="lp-wrap">
        <h1 data-split>
          Let agents <em>pay</em> your API.
        </h1>
        <p className="lp-lead" data-hero-fade>
          Vellar verifies and settles x402 payments on Stellar and lists every paid endpoint in a
          searchable Bazaar. Charge per request for any API or MCP tool, and let AI agents find you
          and pay in USDC. Open source, non-custodial, fees sponsored.
        </p>
        <div className="lp-cta-row" data-hero-fade>
          <LpButton href="https://docs.vellar.xyz/docs/getting-started/quickstart" variant="sun" size="lg">
            Read the docs
          </LpButton>
          <LpButton
            href="https://github.com/Vellar-Wallet/vellar-facilitator"
            variant="outline"
            size="lg"
          >
            Facilitator on GitHub
          </LpButton>
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
              <Chips items={[{ label: "exact", on: true }, { label: "upto" }, { label: "Bazaar-listed" }]} />
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
      </div>
    </header>
  );
}
