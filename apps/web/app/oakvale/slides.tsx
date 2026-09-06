import type { CSSProperties, ReactNode } from "react";
import { DownloadsChart, type WeeklyDownloads } from "./downloads-chart";

export interface Slide {
  id: string;
  content: ReactNode;
}

// Real weekly npm download data for vellar-sdk, fetched live from the npm API
// (api.npmjs.org/downloads/range) on the day this deck was built. Week 7 is
// partial (2 of 7 days) — flagged rather than left to look like a decline.
const DOWNLOAD_WEEKS: WeeklyDownloads[] = [
  { weekLabel: "Jul 14", total: 303 },
  { weekLabel: "Jul 21", total: 188 },
  { weekLabel: "Jul 28", total: 186 },
  { weekLabel: "Aug 04", total: 57 },
  { weekLabel: "Aug 11", total: 194 },
  { weekLabel: "Aug 18", total: 153 },
  { weekLabel: "Aug 25", total: 29, partial: true },
];
const DOWNLOAD_TOTAL = 1110;

export const SLIDES: Slide[] = [
  // ---------------------------------------------------------------- 1
  {
    id: "title",
    content: (
      <div className="deck-slide-inner">
        <div className="deck-logo-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Vellar" />
          <div className="oakvale-chip">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/oakvale.png" alt="Oakvale Invest" />
          </div>
        </div>
        <p className="deck-eyebrow">Vellar</p>
        <h1>
          Give your agent a budget, <em>not your keys.</em>
        </h1>
        <p className="deck-lead">
          The agent payments stack for Stellar. Smart accounts that pay HTTP 402 APIs autonomously,
          budgets enforced on chain, trust ranked discovery. Secured by passkeys, not seed phrases.
        </p>
        <p className="deck-kicker">Prepared for Oakvale Invest, August 2026</p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 2
  {
    id: "problem",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The problem</p>
        <h2>AI agents can move money. They can&rsquo;t yet act on their own safely.</h2>
        <p className="deck-body">
          A token moving from one address to another is solved. Three things an autonomous agent
          actually needs are not.
        </p>
        <div className="deck-cards">
          <div className="deck-card deck-card--coral">
            <h4>Discover</h4>
            <p>
              An agent can only pay an endpoint it already knows about. There is no open catalog it
              can search.
            </p>
            <span className="deck-card-chip">01</span>
          </div>
          <div className="deck-card deck-card--coral">
            <h4>Spend safely</h4>
            <p>
              A spending limit enforced by the agent&rsquo;s own client code is only as safe as that
              code. Compromise the client, the limit disappears with it.
            </p>
            <span className="deck-card-chip">02</span>
          </div>
          <div className="deck-card deck-card--coral">
            <h4>Verify</h4>
            <p>
              Nothing checks whether a facilitator&rsquo;s own claim about what it settled is
              actually true. The agent is asked to trust a party with every incentive to look good.
            </p>
            <span className="deck-card-chip">03</span>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          Developers can settle a simple transfer today. They cannot yet build an agent that finds a
          service, stays inside a budget the chain itself enforces, and can prove what actually
          happened. <b>That gap is what Vellar closes.</b>
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 3
  {
    id: "thesis",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The thesis</p>
        <h2>
          A budget the chain <em>refuses</em> to exceed, not a promise the client makes.
        </h2>
        <p className="deck-lead">
          An autonomous agent holds a key. That key cannot spend past its budget, not because the
          agent&rsquo;s own software says so, not because a facilitator promises it, but because the
          blockchain itself refuses the transaction.
        </p>
        <p className="deck-lead">
          A fourth, unrelated party can check the entire chain of that claim from the outside,
          trusting none of the pieces above it.
        </p>
        <p className="deck-body" style={{ marginTop: "2.5rem", fontSize: "1.25rem" }}>
          That is not a feature sitting on top of a payments product.{" "}
          <span className="deck-headline-number">It is the architecture.</span>
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 4
  {
    id: "proven",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">How it works, proven in four places</p>
        <h2>Four systems. One claim, proven independently four times.</h2>
        <div className="deck-flow">
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--lime">
              <h4>The wallet mints the budget</h4>
              <p>
                A passkey-secured smart account attaches a spending policy enforced on chain — a
                payment under budget settles, the identical mechanism over budget is rejected by the
                chain before anything moves.
              </p>
              <span className="deck-card-chip">01 · Wallet</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--mint">
              <h4>The SDK is what the agent holds</h4>
              <p>
                A scoped session key signs headlessly, no human, no browser, no prompt. Tested
                against a real 0.5 USDC cap with internal limits set deliberately higher — only the
                chain stopped the overspend.
              </p>
              <span className="deck-card-chip">02 · SDK</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--sun">
              <h4>The facilitator never trusts what it&rsquo;s told</h4>
              <p>
                It re-simulates every payment against the live chain before settling, and hosts
                Bazaar, the discovery layer an agent searches instead of needing a hardcoded URL.
              </p>
              <span className="deck-card-chip">03 · Facilitator</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--coral">
              <h4>The explorer trusts none of the above</h4>
              <p>
                A separately operated service reads the ledger directly and refuses to trust even a
                facilitator&rsquo;s claimed settlement amount, reading the token&rsquo;s own
                on-chain event instead.
              </p>
              <span className="deck-card-chip">04 · Explorer</span>
            </div>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          No single piece tells this story alone.{" "}
          <b>
            Put together, an agent&rsquo;s spending is capped by a mechanism that trusts none of its
            own components.
          </b>
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 5
  {
    id: "marketplace",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The other side of the marketplace</p>
        <h2>
          A catalog is only as good as how easily a <em>seller</em> gets into it.
        </h2>
        <p className="deck-body">
          Everything so far is the buyer&rsquo;s side — an agent finding and paying for something.
        </p>
        <div className="deck-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          <div className="deck-card deck-card--lime">
            <h4>Live today</h4>
            <p>
              Listing requires no separate signup — a resource is added to Bazaar automatically the
              moment a real payment settles against it.
            </p>
            <span className="deck-card-chip">Shipped</span>
          </div>
          <div className="deck-card deck-card--mint">
            <h4>Coming next</h4>
            <p>
              A dedicated developer tool — a Vellar extension for the code editor a developer
              already works in — so listing a paid endpoint or a paid MCP tool takes no more effort
              than writing the endpoint itself.
            </p>
            <span className="deck-card-chip">Upcoming</span>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 6
  {
    id: "why-ai",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Why AI is not a feature here</p>
        <h2>Remove the autonomous agent, and two hard problems disappear.</h2>
        <div className="deck-cards">
          <div className="deck-card deck-card--lime">
            <h4>The catalog defends against its own reader</h4>
            <p>
              A seller writes a listing description; an agent reads it and decides what to do. That
              makes the catalog an attack surface the moment the reader is a model, not a person.
              Every listing is fenced as untrusted data before it reaches an agent&rsquo;s reasoning
              — the same fence, independently implemented twice, kept in sync on purpose.
            </p>
            <span className="deck-card-chip">A</span>
          </div>
          <div className="deck-card deck-card--mint">
            <h4>Discovery speaks the language an agent already speaks</h4>
            <p>
              Not a website with an API bolted on — an MCP server, the same tool-calling interface a
              model&rsquo;s own reasoning loop already uses for everything else.
            </p>
            <span className="deck-card-chip">B</span>
          </div>
          <div className="deck-card deck-card--sun">
            <h4>The honesty is repeated on purpose</h4>
            <p>
              &ldquo;Verified does not mean safe&rdquo; appears independently, in the same words, in
              two different parts of the stack — a real security boundary and a mere reputation
              signal must never be confused, especially by a model deciding whether to spend.
            </p>
            <span className="deck-card-chip">C</span>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 7
  {
    id: "evidence",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Evidence, not claims</p>
        <h2>Every number below is checkable, not asserted.</h2>
        <div className="deck-split">
          <div>
            <DownloadsChart weeks={DOWNLOAD_WEEKS} total={DOWNLOAD_TOTAL} />
          </div>
          <div className="deck-evidence" style={{ marginTop: 0 }}>
            <div className="deck-evidence-row">
              <span className="num">514</span>
              <span className="label">SDK tests passing, 0 failures</span>
            </div>
            <div className="deck-evidence-row">
              <span className="num">✓</span>
              <span className="label">
                Real settlement transaction hashes, independently confirmed on chain, not simulated
              </span>
            </div>
            <div className="deck-evidence-row">
              <span className="num">4.4%</span>
              <span className="label">
                of everything the independent public explorer has indexed across the entire visible
                testnet ecosystem is attributed to us — the other 95.6% is third-party activity it
                found on its own. That&rsquo;s proof it audits the ecosystem, not a mirror built to
                flatter ourselves.
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 8
  {
    id: "competitive",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Competitive position</p>
        <h2>Not trying to be the only facilitator on Stellar.</h2>
        <p className="deck-lead">
          Healthy competition is good for the ecosystem, and we say so plainly. What we believe we
          are, today, is the only one with all of the following at once:
        </p>
        <div className="deck-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          <div className="deck-card deck-card--lime">
            <p>
              <b>Open discovery catalog</b>
            </p>
          </div>
          <div className="deck-card deck-card--mint">
            <p>
              <b>Agent-facing interface, both sides of a transaction</b>
            </p>
          </div>
          <div className="deck-card deck-card--coral">
            <p>
              <b>Payments gated on verified provenance</b>
            </p>
          </div>
          <div className="deck-card deck-card--sun">
            <p>
              <b>Independent, external verification of what actually settled</b>
            </p>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 9
  {
    id: "addressed",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Addressed directly</p>
        <h2>Two real gaps, stated plainly rather than left for diligence to find.</h2>
        <div className="deck-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          <div className="deck-card deck-card--coral">
            <h4>One founder built this</h4>
            <p>
              Every repository, every contract, every audit finding fixed — alone. That&rsquo;s not
              a story about limits, it&rsquo;s evidence of what one person can execute without
              funding. This round exists to add hands, not to replace the one that already shipped.
            </p>
            <span className="deck-card-chip">Gap 01</span>
          </div>
          <div className="deck-card deck-card--coral">
            <h4>No external audit exists yet</h4>
            <p>
              What exists is real: two rigorous internal security reviews, one returning an explicit
              no-go-for-mainnet verdict on its own findings, every finding since fixed and
              test-backed. What&rsquo;s never happened is a third-party firm checking that work.
              This funding names that audit as its own line item, not an afterthought.
            </p>
            <span className="deck-card-chip">Gap 02</span>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 10
  {
    id: "team",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Team</p>
        <div className="deck-card deck-card--mint" style={{ maxWidth: 880, padding: "2.75rem" }}>
          <div className="deck-team-head">
            <div>
              <div className="deck-team-name">David Ejere</div>
              <div className="deck-team-role">
                Founder &middot; Fullstack &amp; Blockchain Engineer
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/david.jpg" alt="David Ejere" className="deck-team-photo" />
          </div>
          <p className="deck-body" style={{ marginTop: "1.25rem" }}>
            Five-plus years across fullstack and blockchain development. Former Stellar Fellowship
            member and open-source contributor across the ecosystem, including KindFi, Boundless,
            and Trustless Work, and winner of Best Technical Integration at the Boundless ×
            Trustless Work Hackathon.
          </p>
          <p className="deck-body" style={{ marginBottom: 0 }}>
            Built and currently leads all of it: the passkey smart wallet and on-chain spending
            policies published as <code>vellar-sdk</code> on npm, the Soroban contract suite behind
            the attestation registry and spending policies, and the x402 facilitator with its
            discovery layer and agent-facing interfaces.
          </p>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 11
  {
    id: "roadmap",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Roadmap</p>
        <h2>Four deliverables, each tied to a tranche of this round.</h2>
        <div className="deck-milestones">
          <div className="deck-milestone deck-card--lime">
            <h4>Hardening</h4>
            <p>Operational hardening of the infrastructure already live.</p>
            <span className="deck-milestone-num">1</span>
          </div>
          <div className="deck-milestone deck-card--mint">
            <h4>Trust layer</h4>
            <p>
              Completing the trust and verification layer — closing the two gaps already known and
              documented.
            </p>
            <span className="deck-milestone-num">2</span>
          </div>
          <div className="deck-milestone deck-card--sun">
            <h4>Upstream</h4>
            <p>
              An upstream contribution of the metered payment scheme to the x402 standard itself —
              work that benefits the whole ecosystem, not only us.
            </p>
            <span className="deck-milestone-num">3</span>
          </div>
          <div className="deck-milestone deck-card--coral">
            <h4>Mainnet</h4>
            <p>Mainnet launch, gated on the external security audit this round funds directly.</p>
            <span className="deck-milestone-num">4</span>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          Beyond this round: a dedicated seller onboarding tool, the editor extension from earlier,
          so listing a paid endpoint takes no more effort than writing it.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 12
  {
    id: "ask",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The ask</p>
        <div className="deck-ask-number">ZAR 1,611,000</div>
        <p className="deck-lead">
          Approximately $100,000 USD at the exchange rate current as of this writing.
        </p>
        <div className="deck-budget-grid">
          <div className="deck-budget-item" style={{ "--fill-pct": "55%" } as CSSProperties}>
            <div className="t">
              <span className="cat">Product development</span>
              <span className="pct">55%</span>
            </div>
            <div className="track">
              <div className="fill">55%</div>
            </div>
            <div className="desc">Engineering time across every deliverable above.</div>
          </div>
          <div className="deck-budget-item" style={{ "--fill-pct": "20%" } as CSSProperties}>
            <div className="t">
              <span className="cat">External security audit</span>
              <span className="pct">20%</span>
            </div>
            <div className="track">
              <div className="fill">20%</div>
            </div>
            <div className="desc">
              The one gap named previously, funded directly rather than deferred.
            </div>
          </div>
          <div className="deck-budget-item" style={{ "--fill-pct": "15%" } as CSSProperties}>
            <div className="t">
              <span className="cat">Infrastructure &amp; operations</span>
              <span className="pct">15%</span>
            </div>
            <div className="track">
              <div className="fill">15%</div>
            </div>
            <div className="desc">
              Always-on hosting, monitoring, the reliability a production payment rail requires.
            </div>
          </div>
          <div className="deck-budget-item" style={{ "--fill-pct": "10%" } as CSSProperties}>
            <div className="t">
              <span className="cat">Early customers &amp; go to market</span>
              <span className="pct">10%</span>
            </div>
            <div className="track">
              <div className="fill">10%</div>
            </div>
            <div className="desc">
              Design partners, documentation — turning working infrastructure into something teams
              adopt.
            </div>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "1.5rem" }}>
          Released as an approval payment plus four tranches, one per roadmap deliverable — not
          handed over in a single lump. A staged structure, because the deliverables above are real
          and checkable one at a time.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 13
  {
    id: "close",
    content: (
      <div className="deck-slide-inner">
        <h2>
          The safety layer underneath the agent economy on Stellar — proven on chain, checked from
          outside.
        </h2>
        <p className="deck-lead">
          Built by one founder who is now asking for the resources to do it faster, not to prove it
          works for the first time.
        </p>
        <div className="deck-logo-row" style={{ marginTop: "3rem", marginBottom: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Vellar" />
        </div>
        <p className="deck-kicker" style={{ marginTop: "2rem" }}>
          vellar.xyz · docs.vellar.xyz · explorer.vellar.xyz · david@vellar.xyz
        </p>
      </div>
    ),
  },
];
