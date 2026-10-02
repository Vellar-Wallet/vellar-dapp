import { LpButton } from "./ui";
import { HeroWaves } from "./hero-waves";
import { Reveal } from "./reveal";

/** Landing hero: the poster statement, set as a sticky scene that shrinks
 *  and tilts away on scroll (see scenes.tsx).
 *
 *  The headline is the condensed display face at poster scale, with the
 *  one rationed italic serif emphasis word the system allows. The three
 *  product mock cards that used to sit here moved into the pillars
 *  section below: a 100vh scene cannot hold a poster headline and a
 *  three-card grid without one of them being cramped, and the cards read
 *  better next to the copy that explains them.
 *
 *  Entrance stagger follows the reference spec's hero budget (§4.2):
 *  0.1 / 0.25 / 0.4 / 0.55s, with the largest element given the longest
 *  travel and duration. */
export function Hero() {
  return (
    <header className="lp-hero">
      <HeroWaves />
      <div className="lp-wrap">
        <Reveal delay={0.1} y={20} className="lp-hero-eyebrow">
          <span className="lp-micro lp-micro--wide">x402 on Stellar</span>
        </Reveal>

        <Reveal delay={0.25} y={40} duration={0.8} as="h1" className="lp-poster lp-hero-poster">
          Let agents <em>pay</em> your API.
        </Reveal>

        <Reveal delay={0.4} y={20}>
          <p className="lp-lead">
            Vellar verifies and settles x402 payments on Stellar and lists every paid endpoint in a
            searchable Bazaar. Charge per request for any API or MCP tool, and let AI agents find you
            and pay in USDC. Open source, non-custodial, fees sponsored.
          </p>
        </Reveal>

        <Reveal delay={0.55} y={15}>
          <div className="lp-cta-row">
            <LpButton
              href="https://docs.vellar.xyz/docs/getting-started/quickstart"
              variant="sun"
              size="lg"
            >
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
        </Reveal>
      </div>
    </header>
  );
}
