import { Eyebrow } from "./ui";

const FAQS = [
  {
    q: "How do I start charging for an API?",
    a: "Point your resource server at the Vellar facilitator and gate a route with a 402 challenge. Settlement, fee sponsorship and Bazaar cataloging are handled for you, with no Soroban code in your app. The VS Code extension can write the gate into an Express, Fastify or Next.js App Router route for you.",
  },
  {
    q: "How does an agent find and pay an endpoint?",
    a: "It searches the Bazaar, then pays and calls the endpoint in one step, with no pre-shared API key. Agents can use the CLI (npx vellar-cli search, then npx vellar-cli pay) or query the catalog through the MCP discovery server.",
  },
  {
    q: "How does an endpoint get listed in the Bazaar?",
    a: "Only after a real settlement carrying the discovery extension, and only if the discovery data is valid, the payTo is bound correctly, and the ownership checks against the resource's own 402 challenge pass. It can't be spammed for free.",
  },
  {
    q: "Do you ever hold my funds or keys?",
    a: "No. Buyers sign a payment authorization and never hand over keys. Vellar verifies and settles the signed payment; it never holds buyer funds or private keys.",
  },
  {
    q: "Which networks, tokens and payment schemes work today?",
    a: "Stellar testnet today, and Vellar settled its first payments on Stellar mainnet in September 2026. Any SEP-41 or Stellar Asset Contract token works, with USDC as the default. The exact scheme settles a fixed, pre-agreed amount; upto settles a metered amount up to a signed ceiling, which suits usage-based pricing, and is testnet-only for now.",
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
                {f.q} <span className="pm" aria-hidden="true" />
              </summary>
              <div className="body">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
