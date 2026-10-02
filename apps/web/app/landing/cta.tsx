import { LpButton } from "./ui";
import { Reveal } from "./reveal";

/** The closing band: the poster headline once more, then the two ways in.
 *
 *  Reference spec §4.8 closes on a giant condensed headline over a warped
 *  wordmark image. The wordmark is a brand asset we do not have and may
 *  not reproduce, so the headline carries the band on its own, and the
 *  footer's faint logo watermark does the wordmark's job below it.
 *
 *  Entrance follows the same Reveal stagger as the hero. */
export function SdkCta() {
  return (
    <section className="lp-cta lp-invert" id="cta">
      <div className="lp-wrap">
        <Reveal delay={0.1} y={40} duration={0.8} as="h2" className="lp-poster lp-poster--sm">
          Get paid by agents <em>today.</em>
        </Reveal>
        <Reveal delay={0.25} y={20}>
          <p>
            Add an x402 payment gate to any endpoint in minutes, open source, non-custodial, fees
            sponsored.
          </p>
        </Reveal>
        <Reveal delay={0.4} y={15}>
          <div className="lp-cta-row">
            <LpButton href="https://docs.vellar.xyz/" variant="sun" size="lg">
              Read the docs
            </LpButton>
            <LpButton
              href="https://github.com/Vellar-Wallet/vellar-facilitator"
              variant="ghost"
              size="lg"
            >
              View on GitHub
            </LpButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
