import { Eyebrow } from "./ui";

const FAQS = [
  {
    q: "What does Vellar actually do?",
    a: "Vellar is the payment layer for AI agents on Stellar, built on x402. Its facilitator verifies signed payments, settles them on-chain and sponsors the network fee; the Bazaar catalogs paid endpoints so agents can find them; and a VS Code extension, a CLI and an MCP discovery server give sellers and agents tools to use both.",
  },
  {
    q: "Is Vellar custodial?",
    a: "No. Buyers sign a payment authorization and never hand over keys. Vellar verifies and settles the signed payment, it never holds buyer funds or private keys.",
  },
  {
    q: "What networks and tokens does it support?",
    a: "Stellar testnet today. Vellar settled its first payments on Stellar mainnet in September 2026. Any SEP-41 or Stellar Asset Contract token works; USDC is the default.",
  },
  {
    q: "What's the difference between exact and upto?",
    a: "exact settles a fixed, pre-agreed amount. upto settles a metered amount up to a signed ceiling, useful for usage-based pricing. upto is testnet-only for now.",
  },
  {
    q: "How does a resource get listed in the Bazaar?",
    a: "Only after a real settlement carrying the discovery extension, and only if the discovery data is valid, the payTo is bound correctly, and the ownership checks against the resource's own 402 challenge pass. It can't be spammed for free.",
  },
  {
    q: "Has Vellar been audited?",
    a: "Not independently, not yet. It's testnet-only and pre-production; an external security audit is planned before a production release tag.",
  },
] as const;

/** FAQ: aside + native details/summary accordion. */
export function FaqSection() {
  return (
    <section className="lp-sec lp-ground--tint" id="faq">
      <div className="lp-wrap lp-faq-grid">
        <div className="lp-faq-aside" data-reveal>
          <Eyebrow>Questions</Eyebrow>
          <h2 className="mt-[var(--lp-sp-4)]!">Frequently asked questions</h2>
          <p className="mt-[var(--lp-sp-4)]! text-[length:var(--lp-fs-sm)] leading-relaxed text-[var(--lp-ink-soft)]">
            Still curious? Reach us at <a href="mailto:hello@vellar.xyz">hello@vellar.xyz</a> or
            read the <a href="https://docs.vellar.xyz/">facilitator docs</a>.
          </p>
        </div>
        <div data-reveal-group>
          {FAQS.map((f) => (
            <details className="lp-fitem" key={f.q}>
              <summary>
                {f.q} <span className="pm">+</span>
              </summary>
              <div className="body">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
