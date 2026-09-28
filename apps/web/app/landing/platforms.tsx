import { LpButton, MonoRow, MonoRows } from "./ui";

/** Sellers list an endpoint, agents find and pay it — the two sides of
 *  the Bazaar. */
export function TwoSides() {
  return (
    <section className="lp-sec lp-sec--tight" id="bazaar">
      <div className="lp-wrap">
        <div className="lp-plat" data-reveal-group>
          <div className="lp-platcard lp-platcard--paper">
            <h3>For sellers</h3>
            <p>
              Point your resource server at the Vellar facilitator and gate any route with a 402
              challenge. Settlement, fee sponsorship and Bazaar cataloging come for free, no Soroban
              code in your app.
            </p>
            <div className="mini">
              <MonoRows>
                <MonoRow label="FACILITATOR_URL=" />
                <MonoRow label="https://vellar-facilitator.onrender.com" />
                <MonoRow label="npm install @x402/core @x402/stellar" />
                <MonoRow label="register('stellar:testnet', exact)" value="✓" tone="ok" />
              </MonoRows>
            </div>
            <div className="lp-cta-row">
              <LpButton
                href="https://docs.vellar.xyz/docs/sellers/charge-for-an-endpoint"
                variant="forest"
              >
                Seller quickstart
              </LpButton>
            </div>
          </div>
          <div className="lp-platcard lp-platcard--dark">
            <h3>For agents</h3>
            <p>
              Search the Bazaar for a payable endpoint, then pay and call it in one step, no
              pre-shared API key. AI agents can also query the catalog through an MCP discovery
              server, or reach for the CLI.
            </p>
            <div className="mini">
              <MonoRows>
                <MonoRow label='$ npx vellar-cli search "weather"' />
                <MonoRow label="$ npx vellar-cli pay <url>" value="✓ paid" tone="ok" />
              </MonoRows>
            </div>
            <div className="lp-cta-row">
              <LpButton href="https://docs.vellar.xyz/docs/buyers/discover-services" variant="sun">
                Buyer tools
              </LpButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
