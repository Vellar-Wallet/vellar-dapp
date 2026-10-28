import type { Slide } from "../oakvale/slides";

/**
 * General-use investor/partner pitch deck, built on the actual current
 * landing page's visual language (poster headlines, numbered pastel
 * pillar cards, pill buttons, ink/paper/lime grounds — see pitch.css's
 * header comment), not a separate "editorial" style.
 *
 * Every number is sourced from the live docs at docs.vellar.xyz as of
 * 2026-10-04 (content/docs/reference/proofs.md, explorer.md,
 * evaluation.md, honesty.md), which are explicit about testnet vs.
 * mainnet and about what is NOT yet proven — that distinction is kept
 * intact here rather than rounded away. No ask / use-of-funds slide:
 * this is the general-use version, not a priced round's brief.
 */

export const SLIDES: Slide[] = [
  // ---------------------------------------------------------------- 1. Title
  {
    id: "title",
    content: (
      <div className="pitch-slide pitch-title lp-ground--ink">
        <span className="pitch-eyebrow">x402 on Stellar</span>
        <h1 className="pitch-poster">
          The payment layer <br />
          for AI <em>agents.</em>
        </h1>
        <p className="pitch-lead">
          Vellar verifies and settles x402 payments on Stellar, lists every paid endpoint in a
          searchable Bazaar, and gives agents a budget instead of your keys. Open source,
          non-custodial, fees sponsored.
        </p>
        <div className="pitch-title-foot">
          <span className="pitch-chip">vellar.xyz</span>
          <span className="pitch-chip">docs.vellar.xyz</span>
          <span className="pitch-chip">github.com/Vellar-Wallet</span>
        </div>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 2. Problem
  {
    id: "problem",
    content: (
      <div className="pitch-slide">
        <span className="pitch-eyebrow">The gap</span>
        <h2 className="pitch-h2">
          AI agents can act. <em>They cannot safely spend.</em>
        </h2>
        <p className="pitch-lead">
          Agents already chain tools and call APIs. The moment execution hits an external paywall —
          a $0.02 search, a $0.10 scrape, a $1.00 compute call — it breaks down into two flawed
          extremes: a human approves every call, which kills autonomy, or the agent holds a raw
          private key, which is one bad prompt away from a drained wallet.
        </p>
        <div className="pitch-pillars" style={{ "--cols": 3 } as React.CSSProperties}>
          <div className="pitch-pillar">
            <span className="num">01</span>
            <h4>Web2 API keys</h4>
            <p>
              A human approves every $0.05 call, or a static key gets handed to the agent outright.
              Either kills autonomy or removes the guardrail entirely.
            </p>
          </div>
          <div className="pitch-pillar">
            <span className="num">02</span>
            <h4>Unbounded Web3 wallet</h4>
            <p>
              The agent holds a raw private key with no spending ceiling. One compromised process or
              hallucinated tool call drains the wallet.
            </p>
          </div>
          <div className="pitch-pillar">
            <span className="num">03</span>
            <h4>The Vellar standard</h4>
            <p>
              A human sets a budget once, enforced on-chain. The agent transacts freely inside it —
              autonomous, and provably bounded.
            </p>
          </div>
        </div>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 3. Solution
  {
    id: "solution",
    content: (
      <div className="pitch-slide lp-ground--tint">
        <span className="pitch-eyebrow">The solution</span>
        <h2 className="pitch-h2">
          A budget, <em>not your keys.</em>
        </h2>
        <p className="pitch-lead">
          A human sets a spending policy once, on-chain. The agent transacts autonomously, strictly
          inside that limit, and cannot override it — not even by compromising the process it runs
          in.
        </p>
        <div className="pitch-evidence">
          <div className="pitch-evidence-row">
            <span className="num">Wallet</span>
            <span className="label">
              A non-custodial Soroban smart account enforcing hard spending limits inside{" "}
              <code>__check_auth</code> — the chain refuses an over-budget payment before any funds
              move.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Facilitator</span>
            <span className="label">
              A hosted verify/settle service, wire-compatible with the canonical x402 clients.
              Re-simulates every payment — which runs the buyer's own on-chain policy — before
              anything settles.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Bazaar</span>
            <span className="label">
              Every settled payment auto-catalogs its resource. No registration, no API key — a
              listing is a side effect of a real payment, so spam costs real money.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">MCP + CLI</span>
            <span className="label">
              An MCP server and CLI let an agent discover, quote, and pay for a resource in one
              step. The process-level guard is convenience; the on-chain policy is the actual
              security boundary.
            </span>
          </div>
        </div>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 4. How it works
  {
    id: "how-it-works",
    content: (
      <div className="pitch-slide">
        <span className="pitch-eyebrow">How it works</span>
        <h2 className="pitch-h2">
          Six steps, <em>and one that matters most.</em>
        </h2>
        <p className="pitch-lead">
          x402 turns HTTP 402 into a machine-payable API call. Verification is not a signature check
          — the facilitator re-simulates the whole transaction, which runs the buyer's own{" "}
          <code>__check_auth</code>, so a spending-limit policy is enforced before anything settles.
        </p>
        <div className="pitch-evidence pitch-evidence--tight">
          {[
            ["1", "Buyer requests the resource with no payment — nothing is spent yet"],
            ["2", "Seller responds 402 with price, asset, recipient, and a timeout"],
            ["3", "Buyer signs a Soroban authorization: one asset, one amount, one recipient"],
            ["4", "Buyer retries the request carrying the signed PAYMENT-SIGNATURE"],
            ["5", "Facilitator re-simulates — this runs the policy, before any funds move"],
            ["6", "Facilitator settles on-chain, sponsors the fee, returns the settlement hash"],
          ].map(([num, label]) => (
            <div className="pitch-evidence-row" key={num}>
              <span className="num">{num}</span>
              <span className="label">{label}</span>
            </div>
          ))}
        </div>
        <div className="pitch-callout pitch-callout--tight">
          <span className="pitch-callout-kicker">The non-custodial property</span>
          <p>
            The facilitator is never a party to the transfer. Funds move directly from buyer to
            seller.{" "}
            <b>It can refuse to submit a payment, but it cannot redirect one or hold your money.</b>
          </p>
        </div>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 5. Market
  {
    id: "market",
    content: (
      <div className="pitch-slide pitch-slide--dense lp-ground--tint">
        <span className="pitch-eyebrow">Market sizing</span>
        <h2 className="pitch-h2" style={{ marginBottom: "var(--lp-sp-4)" }}>
          Capturing the payment rail <em>of machine-to-machine commerce.</em>
        </h2>

        <div className="pitch-figs-row">
          <div className="pitch-fig-col">
            <p className="pitch-fig-label">Total Addressable Market (TAM)</p>
            <span className="pitch-fig-value">$3T&ndash;$5T</span>
            <p className="pitch-fig-cap">
              Global agentic commerce orchestrated spend by 2030.
              <span className="pitch-fig-src">McKinsey QuantumBlack</span>
            </p>
          </div>
          <div className="pitch-fig-col">
            <p className="pitch-fig-label">Serviceable Addressable Market (SAM)</p>
            <span className="pitch-fig-value">$322B</span>
            <span className="pitch-fig-arrow">&rarr;</span>
            <span className="pitch-fig-value">$409B</span>
            <p className="pitch-fig-cap">
              Regulated stablecoin payment infrastructure, 2025&ndash;2026, 26.9% CAGR &mdash; the
              rail agent-to-agent payments actually settle on.
              <span className="pitch-fig-src">Industry market-sizing estimate, 2026</span>
            </p>
          </div>
        </div>

        <p className="pitch-lead" style={{ marginBottom: "var(--lp-sp-3)" }}>
          Bottom-up math for our <b>Serviceable Obtainable Market (SOM)</b>, anchored to Stellar's
          own stablecoin volume rather than the macro TAM:
        </p>
        <div className="pitch-som-equation">
          <div className="pitch-som-input">
            <span className="v">$17.9B</span>
            <span className="l">Annual USDC volume on Stellar</span>
            <span className="d">91.3M transactions, Sep 2024–Sep 2025</span>
          </div>
          <div className="pitch-som-input">
            <span className="v">5%</span>
            <span className="l">Share routed through x402-gated endpoints</span>
            <span className="d">Conservative estimate</span>
          </div>
          <div className="pitch-som-input">
            <span className="v">0.5%</span>
            <span className="l">Facilitator take rate</span>
            <span className="d">Verify + settle + sponsor the fee</span>
          </div>
        </div>
        <div className="pitch-som-result">
          <span className="label">Illustrative annual facilitator revenue at scale</span>
          <span className="value">$4.5M</span>
          <span className="detail">
            from ~$895M in annual gated payment volume at a 0.5% take rate
          </span>
        </div>
        <p className="pitch-note" style={{ marginTop: "var(--lp-sp-3)" }}>
          This is a bottom-up estimate off Stellar's own measured stablecoin volume, not the macro
          TAM — deliberately conservative, and an estimate, not a result already achieved.
        </p>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 6. Traction
  {
    id: "traction",
    content: (
      <div className="pitch-slide">
        <span className="pitch-eyebrow">Proof, not promises</span>
        <h2 className="pitch-h2">
          Live on testnet. <em>Live on mainnet.</em>
        </h2>
        <p className="pitch-lead" style={{ marginBottom: 0 }}>
          Every figure below links to a ledger, a doc, or a repo that proves it. Testnet and mainnet
          are kept separate on purpose.
        </p>

        <div className="pitch-stats-row" style={{ "--cols": 3 } as React.CSSProperties}>
          <div className="pitch-stat">
            <span className="v">390</span>
            <span className="l">testnet settlements, 303 unique buyers, 6-week window</span>
          </div>
          <div className="pitch-stat">
            <span className="v">11</span>
            <span className="l">
              real mainnet settlements, ~3.6 USDC — live today, scaling deliberately
            </span>
          </div>
          <div className="pitch-stat">
            <span className="v">386 / 7,988</span>
            <span className="l">
              testnet payments an independent, non-Vellar ledger indexer attributes to Vellar
            </span>
          </div>
        </div>

        <p className="pitch-kicker">A real security fix, with on-chain before/after proof</p>
        <div className="pitch-evidence">
          <div className="pitch-evidence-row">
            <span className="num">Before</span>
            <span className="label">
              An attacker could settle to a different payTo and overwrite the catalog entry,
              inheriting the legitimate seller&rsquo;s trust stats (ledger 4040689).
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">After</span>
            <span className="label">
              Identical attack attempted again — the catalog entry is unchanged and protected
              (ledger 4040706). The payment still settles; only the catalog was hardened.
            </span>
          </div>
        </div>
        <p className="pitch-note">
          Vellar is listed in the official <b>Stellar developer documentation</b> as a community
          x402 facilitator (stellar/stellar-docs PR #2836, merged), and its facilitator passed a
          pre-mainnet security review covering the service, settlement path, and catalog ownership
          system.
        </p>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 7. Why now
  {
    id: "why-now",
    content: (
      <div className="pitch-slide lp-ground--tint">
        <span className="pitch-eyebrow">Why now</span>
        <h2 className="pitch-h2">
          The protocol has <em>Big Tech behind it.</em>
        </h2>
        <p className="pitch-lead">
          x402 was created by Coinbase in May 2025. Within three quarters, cumulative agentic
          transactions passed 100 million. Google, Microsoft, AWS, Cloudflare, Circle, and Stripe
          now back the x402 Foundation governing the standard — and in July 2026, Coinbase opened
          x402 payments to every Coinbase Business customer.
        </p>
        <p className="pitch-kicker">
          An agent cannot buy a $0.05 scrape if the network fee is $1.50
        </p>
        <div className="pitch-fee-lines">
          <div className="pitch-fee-line">
            <span className="name">Ethereum L1</span>
            <span className="track">
              <span className="fill" style={{ width: "100%" }} />
            </span>
            <span className="amt">$1.50&ndash;$5+</span>
          </div>
          <div className="pitch-fee-line">
            <span className="name">EVM L2 / Base</span>
            <span className="track">
              <span className="fill" style={{ width: "4%" }} />
            </span>
            <span className="amt">$0.01&ndash;$0.05</span>
          </div>
          <div className="pitch-fee-line is-lead">
            <span className="name">Vellar / Stellar</span>
            <span className="track">
              <span className="fill" style={{ width: "0.2%" }} />
            </span>
            <span className="amt">~$0.001</span>
          </div>
        </div>
        <p className="pitch-note">
          Adoption is real but still early and uneven — on-chain activity surged, then cooled
          through early 2026, which is why distribution and a working product today matter more than
          timing a wave.
        </p>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 8. Competitive position
  {
    id: "competitive",
    content: (
      <div className="pitch-slide">
        <span className="pitch-eyebrow">Competitive position</span>
        <h2 className="pitch-h2" style={{ marginBottom: "var(--lp-sp-4)" }}>
          The protocol is open. <em>The enforcement is ours.</em>
        </h2>
        <div className="pitch-callout pitch-callout--tight">
          <span className="pitch-callout-kicker">
            Why a generic x402 facilitator can't just copy this
          </span>
          <p>
            Policy-governed payments cost more gas to verify. Most hosted facilitators cap
            sponsorship low enough to <b>reject</b> them outright. Vellar raised its ceiling 10x
            specifically so agent payments bounded by an on-chain budget settle instead of being
            refused.
          </p>
        </div>
        <p className="pitch-kicker">Capabilities, honestly compared</p>
        <table className="pitch-matrix">
          <thead>
            <tr>
              <th />
              <th className="is-lead">Vellar</th>
              <th>Coinbase x402</th>
              <th>Generic facilitator</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["On-chain spending-limit policy", true, false, false],
              ["Accepts policy-governed payments", true, false, false],
              ["Discovery marketplace (Bazaar)", true, false, false],
              ["Independent ledger-based verification", true, false, false],
              ["Wire-compatible with canonical x402 clients", true, true, true],
            ].map(([capability, ...cells]) => (
              <tr key={capability as string}>
                <th scope="row">{capability as string}</th>
                {(cells as boolean[]).map((v, i) => (
                  <td key={i} className={i === 0 ? "is-lead" : undefined}>
                    <span className={v ? "yes" : "no"}>{v ? "✓" : "—"}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 9. Moat
  {
    id: "moat",
    content: (
      <div className="pitch-slide lp-ground--ink">
        <span className="pitch-eyebrow">The moat</span>
        <h2 className="pitch-h2">
          Trust flows downward <em>from the chain, never upward.</em>
        </h2>
        <p className="pitch-lead">
          A compromised client cannot make the facilitator settle something the chain refuses. A
          compromised facilitator cannot make the policy contract approve a payment over its cap —
          Stellar consensus decides, not Vellar's infrastructure.
        </p>
        <div className="pitch-evidence">
          <div className="pitch-evidence-row">
            <span className="num">Layer 1</span>
            <span className="label">
              Process-level ceiling in the agent's own runtime — guards against mistakes, resets on
              restart.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Layer 2</span>
            <span className="label">
              On-chain spending-limit policy inside __check_auth — the real security boundary.
              Survives a fully compromised agent process.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Proof</span>
            <span className="label">
              0.1 USDC under a 0.5 USDC cap settled; 0.6 USDC over cap was refused by the chain
              itself, balance unaffected — confirmed by on-chain arithmetic.
            </span>
          </div>
        </div>
        <p className="pitch-note">
          Boring infrastructure most competitors skip: exactly 50 dedicated channel accounts remove
          shared-sequence-number collisions under concurrent settlement load. Catalog listings cost
          real on-chain money to fake, so the cost of an attack scales linearly with its size, and
          the attacker pays it.
        </p>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 10. Honesty
  {
    id: "honesty",
    content: (
      <div className="pitch-slide lp-ground--tint">
        <span className="pitch-eyebrow">What we won't overclaim</span>
        <h2 className="pitch-h2">
          Narrow claims, <em>held precisely.</em>
        </h2>
        <p className="pitch-lead">
          The same discipline that makes the proof slide credible means being explicit about what
          isn't true yet.
        </p>
        <div className="pitch-evidence">
          <div className="pitch-evidence-row">
            <span className="num">Audit</span>
            <span className="label">
              The spending-limit policy contract has not had a mainnet security audit. The
              facilitator itself passed review; the policy contract is separate, ongoing work.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Scope</span>
            <span className="label">
              The on-chain policy bounds how much an agent can spend. It does not guard who receives
              it — recipient-safety is the application's job.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Scale</span>
            <span className="label">
              Mainnet volume is proof of capability (11 settlements), not proof of scale. Search
              quality numbers are a regression baseline on 19 catalog entries, not a quality claim
              at any larger size.
            </span>
          </div>
          <div className="pitch-evidence-row">
            <span className="num">Scheme</span>
            <span className="label">
              The metered (upto) settlement scheme is experimental and testnet-only; the main SDK
              does not yet build upto payments.
            </span>
          </div>
        </div>
        <p className="pitch-note">
          <b>The defensible claim:</b> an agent cannot spend more than the budget you set, enforced
          by Stellar consensus, even if the agent process is fully compromised. That is proven on a
          public ledger. Claims broader than that are flagged, not implied.
        </p>
      </div>
    ),
  },

  // ---------------------------------------------------------------- 11. Closing
  {
    id: "closing",
    content: (
      <div className="pitch-slide pitch-close lp-ground--ink">
        <span className="pitch-eyebrow">Get in touch</span>
        <h2 className="pitch-poster" style={{ fontSize: "clamp(2rem, 1.5rem + 2.5vw, 3.5rem)" }}>
          Give your agent <em>a budget, not your wallet.</em>
        </h2>
        <p className="pitch-lead">
          Vellar is open source, non-custodial, and live on Stellar mainnet today. Read the docs,
          check the proofs yourself, or reach out to talk about where this fits.
        </p>
        <div className="pitch-title-foot">
          <span className="pitch-chip">docs.vellar.xyz</span>
          <span className="pitch-chip">github.com/Vellar-Wallet</span>
          <span className="pitch-chip">explorer.vellar.xyz</span>
        </div>
      </div>
    ),
  },
];
