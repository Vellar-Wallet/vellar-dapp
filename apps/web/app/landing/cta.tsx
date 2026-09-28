import { LpButton } from "./ui";

/** The inverted "ship it" band that closes every marketing page. */
export function SdkCta() {
  return (
    <section className="lp-cta lp-invert" id="cta">
      <div className="lp-wrap" data-reveal>
        <h2>
          Get paid by agents <em>today.</em>
        </h2>
        <p>
          Add an x402 payment gate to any endpoint in minutes, open source, non-custodial, fees
          sponsored.
        </p>
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
      </div>
    </section>
  );
}
