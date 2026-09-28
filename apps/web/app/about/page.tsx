import type { Metadata } from "next";
import { LpShell } from "../landing/shell";
import { SdkCta } from "../landing/cta";
import { Chips, Eyebrow, Frame, LpButton } from "../landing/ui";
import { PersonaImage } from "./persona-image";

export const metadata: Metadata = {
  title: "About · Vellar",
  description: "About Vellar, the open-source x402 facilitator for Stellar, and the person building it.",
};

export default function About() {
  return (
    <LpShell>
      {/* Intro */}
      <section className="lp-sec">
        <div className="lp-wrap">
          <div className="lp-sechead" data-reveal>
            <div>
              <Eyebrow>About</Eyebrow>
              <h1 data-split className="lp-about-title">
                The <em>facilitator</em> for x402 on Stellar.
              </h1>
            </div>
            <p className="lp-lead">
              Vellar is building on <a href="https://x402.org">x402</a>, the open protocol that
              turns HTTP 402 into machine-payable APIs. Sellers need a way to charge for an API
              without building settlement infrastructure, and agents need a way to find and pay for
              what they need. Vellar is that layer on Stellar.
            </p>
          </div>
          <div className="lp-about-layers" data-reveal-group>
            <div className="lp-about-layer">
              <span className="num">01</span>
              <h4>The facilitator</h4>
              <p>Open source, verifies and settles x402 payments on Stellar, fees sponsored.</p>
            </div>
            <div className="lp-about-layer">
              <span className="num">02</span>
              <h4>The Bazaar</h4>
              <p>Searchable discovery so agents find payable endpoints after a real settlement.</p>
            </div>
            <div className="lp-about-layer">
              <span className="num">03</span>
              <h4>Buyer tools</h4>
              <p>Search and pay for a resource in one step, with an MCP discovery server for agents.</p>
            </div>
            <div className="lp-about-layer">
              <span className="num">04</span>
              <h4>Seller tools</h4>
              <p>Point a resource server at the facilitator and gate any route with a 402 challenge.</p>
            </div>
          </div>
          <div className="lp-about-note" data-reveal>
            <p className="lp-lead">
              Every claim here is meant to be checkable: the facilitator is open source, its
              testnet settlements resolve independently on the Stellar ledger, and it&apos;s listed
              in Stellar&apos;s own x402 documentation as a community facilitator.
            </p>
            <Chips
              items={[
                { label: "Open source", on: true },
                { label: "Non-custodial", on: true },
                { label: "Fees sponsored", on: true },
                { label: "Testnet, mainnet in progress", on: true },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Persona */}
      <section className="lp-sec lp-sec--tight">
        <div className="lp-wrap">
          <div
            className="grid grid-cols-1 gap-[var(--lp-sp-8)] md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center"
            data-reveal
          >
            {/* Upload a photo to apps/web/public/about.jpg to replace the
                initials placeholder. */}
            <Frame className="max-w-[380px]">
              <div className="lp-persona">
                <PersonaImage />
              </div>
            </Frame>
            <div>
              <Eyebrow>Who&apos;s building it</Eyebrow>
              <h2 className="mt-[var(--lp-sp-3)]! text-[length:var(--lp-fs-h3)]!">David Ejere</h2>
              <p className="mt-[var(--lp-sp-2)]! text-[length:var(--lp-fs-eyebrow)] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
                Founder &amp; builder
              </p>
              <p className="lp-lead mt-[var(--lp-sp-4)]!">
                I&apos;m building Vellar so that AI agents can pay for the APIs and tools they use,
                without a seller having to build payment infrastructure and without a buyer having
                to hand over a key. x402 gives us the protocol; Vellar is the open-source
                facilitator and Bazaar that make it work on Stellar, verifiable end to end.
              </p>
              <div className="lp-cta-row">
                <LpButton href="https://github.com/Vellar-Wallet" variant="forest">
                  GitHub
                </LpButton>
                <LpButton href="mailto:david@vellar.xyz" variant="outline">
                  david@vellar.xyz
                </LpButton>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SdkCta />
    </LpShell>
  );
}
