import { DownloadsChart, type WeeklyDownloads } from "../oakvale/downloads-chart";
import type { Slide } from "../oakvale/slides";

// Real weekly npm download data for vellar-sdk, fetched live from the npm API
// (api.npmjs.org/downloads/range) on 2026-09-06. The final week is partial,
// flagged rather than left to look like a collapse.
const DOWNLOAD_WEEKS: WeeklyDownloads[] = [
  { weekLabel: "Jul 14", total: 303 },
  { weekLabel: "Jul 21", total: 188 },
  { weekLabel: "Jul 28", total: 186 },
  { weekLabel: "Aug 04", total: 57 },
  { weekLabel: "Aug 11", total: 194 },
  { weekLabel: "Aug 18", total: 153 },
  { weekLabel: "Aug 25", total: 80 },
  { weekLabel: "Sep 01", total: 5, partial: true },
];
const DOWNLOAD_TOTAL = 1166;

export const SLIDES: Slide[] = [
  // ---------------------------------------------------------------- 1
  {
    id: "title",
    content: (
      <div className="deck-slide-inner">
        <div className="deck-logo-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Vellar" />
        </div>
        <p className="deck-eyebrow">Vellar</p>
        <h1>
          Software is starting to buy and sell. <em>Vellar runs the marketplace.</em>
        </h1>
        <p className="deck-lead">
          AI agents now buy and sell from each other: data, tools, services. Vellar is the
          marketplace underneath that, on Stellar. Buyers get a budget instead of a key, sellers get
          paid per use, we take a fee on every payment that crosses it, and anyone can audit the
          whole thing from outside.
        </p>
        <p className="deck-kicker">Prepared for LAVA, September 2026</p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 2
  {
    id: "shift",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">What changed</p>
        <h2>
          For the first time, <em>the customer isn&rsquo;t a person.</em>
        </h2>
        <p className="deck-body">
          Every payment system ever built assumes a human at the end of it. Someone to read the
          price, click approve, notice the fraud, call the bank. That assumption is now breaking.
        </p>
        <p className="deck-body">
          Software agents already do real work: research, bookings, analysis, code. To finish that
          work they need to buy things: an API call, a dataset, a tool, a service. Millions of tiny
          purchases, made in seconds, with nobody watching.
        </p>
        <div className="deck-ribbon">
          You cannot hand software a credit card. There is no chargeback, no fraud department, and
          no one to notice until the money is gone.
        </div>
        <p className="deck-body">
          So the money moves on stablecoin rails instead. That part already works. What does not
          exist yet is everything a real market needs around it: a way to find what to buy, a limit
          that actually holds, and a receipt anyone can verify.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 3
  {
    id: "already-happening",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">This is not a forecast</p>
        <h2>
          It is already happening. <em>We can count it.</em>
        </h2>
        <p className="deck-body">
          We run a public explorer that watches every one of these machine payments on Stellar, not
          just ours. It reads the ledger directly. Anyone can open it.
        </p>
        <p className="deck-headline-number">7,750</p>
        <div className="deck-chips">
          <span>payments by software, to software</span>
          <span>570 buyers</span>
          <span>535 sellers</span>
          <span>growing daily</span>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          Over a thousand distinct participants, none of them people, already paying each other on
          one chain. This is a market forming in public, early, and mostly unserved.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 4
  {
    id: "problem",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The problem</p>
        <h2>
          Three things missing, <em>and nothing works without them.</em>
        </h2>
        <div className="deck-cards">
          <div className="deck-card deck-card--coral">
            <h4>Nothing to buy from</h4>
            <p>
              An agent can only pay for something it was told about in advance. There is no
              marketplace it can search. Every purchase has to be hardcoded by a developer first.
            </p>
            <span className="deck-card-chip">01</span>
          </div>
          <div className="deck-card deck-card--coral">
            <h4>No spending limit that holds</h4>
            <p>
              Today the limit lives inside the agent&rsquo;s own code. Break the code, the limit
              disappears with it. Nobody puts real money behind a rule the thief can edit.
            </p>
            <span className="deck-card-chip">02</span>
          </div>
          <div className="deck-card deck-card--coral">
            <h4>No trustworthy receipt</h4>
            <p>
              The company that takes your payment also writes the record of what it took. You are
              asked to trust the one party with every reason to shade the truth.
            </p>
            <span className="deck-card-chip">03</span>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          Until all three are solved, nobody trusts software with a budget, and the market stays
          small.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 5
  {
    id: "thesis",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The idea</p>
        <h2>
          The budget is enforced by the blockchain, <em>not by the software.</em>
        </h2>
        <p className="deck-lead">
          Give an agent $50 a day. On day one it tries to spend $5,000. Nothing in our code stops
          it. Nothing in the agent&rsquo;s code stops it. The blockchain itself refuses the
          transaction, because the limit lives on-chain, underneath everything.
        </p>
        <div className="deck-ribbon">
          Steal the agent, rewrite its code, replace its software entirely. The limit still holds.
          It was never yours to change.
        </div>
        <p className="deck-lead">
          That is the difference between a setting and a rule. It is why an owner can hand real
          money to software they do not fully control, which is the thing that has to be true before
          any of this becomes a market.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 6
  {
    id: "how-it-works",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">How it works</p>
        <h2>
          Four parts, <em>each checking the one before it.</em>
        </h2>
        <div className="deck-flow">
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--lime">
              <h4>The wallet sets the budget</h4>
              <p>
                An owner creates a wallet with a face scan or fingerprint, no seed phrase, and sets a
                spending limit that is written to the blockchain.
              </p>
              <span className="deck-card-chip">01 &middot; Wallet</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--mint">
              <h4>The agent spends inside it</h4>
              <p>
                The agent gets its own restricted key. It buys what it needs, alone, with no human
                approving each purchase, and it cannot exceed the budget.
              </p>
              <span className="deck-card-chip">02 &middot; Agent</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--sun">
              <h4>We settle the payment</h4>
              <p>
                Vellar checks the payment against the chain, pays the network fee on the buyer&rsquo;s
                behalf, and settles it in seconds. This is the part we charge for.
              </p>
              <span className="deck-card-chip">03 &middot; Vellar</span>
            </div>
          </div>
          <div className="deck-flow-arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="deck-flow-step">
            <div className="deck-flow-card deck-card deck-card--coral">
              <h4>Anyone can audit us</h4>
              <p>
                A separate public explorer reads the blockchain itself and reports what really settled,
                including when the answer is unflattering to us.
              </p>
              <span className="deck-card-chip">04 &middot; Explorer</span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 7
  {
    id: "business-model",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">How Vellar makes money</p>
        <h2>
          We already do the expensive part. <em>We just haven&rsquo;t charged for it.</em>
        </h2>
        <p className="deck-body">
          Every blockchain payment costs a network fee, and it must be paid in the chain&rsquo;s own
          token. An agent holding only dollars cannot pay it. So Vellar pays it for them today, at
          our own cost, on every single settlement.
        </p>
        <div className="deck-ribbon">
          That cost is our position in the market. We built the marketplace, we cover the cost of
          every transaction in it, and turning on a small fee per payment is a switch, not a new
          product.
        </div>
        <div className="deck-evidence" style={{ marginTop: 0 }}>
          <div className="deck-evidence-row">
            <span className="num">352</span>
            <span className="label">
              payments Vellar has already settled and paid the fee on. Every one of them a
              transaction we could have charged for
            </span>
          </div>
          <div className="deck-evidence-row">
            <span className="num">7,750</span>
            <span className="label">
              payments across the whole visible market. The base we are competing for, growing
              every day
            </span>
          </div>
          <div className="deck-evidence-row">
            <span className="num">×</span>
            <span className="label">
              Revenue is transactions multiplied by a fee. Agents transact constantly and never
              sleep, so the volume is the business, not the size of any one payment
            </span>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 8
  {
    id: "sellers-earn",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Who else makes money</p>
        <h2>
          A market needs sellers. <em>We pay them to show up.</em>
        </h2>
        <p className="deck-body">
          A catalogue with nothing in it is worthless. So the other half of Vellar is the earning
          side, and it is open to two kinds of seller at once.
        </p>
        <div className="deck-cards">
          <div className="deck-card deck-card--lime">
            <h4>Developers get paid per call</h4>
            <p>
              Any developer can put something useful behind a price, whether a dataset, a model,
              a tool or a service, list it on our catalogue, and get paid every time an agent uses
              it. No contract, no invoice, no waiting 30 days.
            </p>
            <span className="deck-card-chip">01</span>
          </div>
          <div className="deck-card deck-card--mint">
            <h4>Agents earn for their owners</h4>
            <p>
              An agent is not only a buyer. It can build something, list it in the catalogue, and be
              paid by other agents that use it. Software earning revenue for the person who owns it,
              while they sleep.
            </p>
            <span className="deck-card-chip">02</span>
          </div>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          Both sides transact through us. Every buy is also a sale, and we settle both ends.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 9
  {
    id: "distribution",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Distribution</p>
        <h2>
          We reach developers <em>where they already work.</em>
        </h2>
        <p className="deck-body">
          The hard part of any marketplace is getting sellers onto it. Ours does not ask a developer
          to visit a website, create an account, or read a contract.
        </p>
        <div className="deck-cards">
          <div className="deck-card deck-card--lime">
            <h4>Straight from the editor</h4>
            <p>
              Vellar installs into VS Code and Cursor, the two places developers already spend
              their day. Start earning from an endpoint without leaving the file you are writing.
            </p>
            <span className="deck-card-chip">01</span>
          </div>
          <div className="deck-card deck-card--mint">
            <h4>Listing happens by itself</h4>
            <p>
              The first time somebody actually pays you, you are in the catalogue. No signup step at
              all. The market builds itself out of things that already worked.
            </p>
            <span className="deck-card-chip">02</span>
          </div>
        </div>
        <div className="deck-ribbon">
          Every AI developer already lives in an editor. That is our storefront, and nobody else is
          standing in it.
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 10
  {
    id: "africa",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Why here, why now</p>
        <h2>
          The card layer never arrived. <em>So we skipped it.</em>
        </h2>
        <p className="deck-body">
          Everything that makes machine payments hard, from no card to no chargeback to no bank in
          the middle, with settlement that has to be final and cheap and instant, describes the
          African payments context before it describes anywhere else.
        </p>
        <p className="deck-body">
          Stablecoin rails were never a workaround here. They were the first thing that worked. A
          market that never got a consumer card layer does not have to unwind one to serve
          software. It starts from where the rest of the world is heading.
        </p>
        <div className="deck-ribbon">
          Built in Nigeria, on the rail Africa already uses most. Infrastructure that works here and
          travels, not a product that only makes sense here.
        </div>
        <p className="deck-body">
          The constraint is real here first. That is why the solution gets built here first.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 11
  {
    id: "evidence",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Evidence, not claims</p>
        <h2>
          It is built, it is running, <em>and you can check it yourself.</em>
        </h2>
        <div className="deck-split">
          <div>
            <DownloadsChart weeks={DOWNLOAD_WEEKS} total={DOWNLOAD_TOTAL} />
          </div>
          <div className="deck-evidence" style={{ marginTop: 0 }}>
            <div className="deck-evidence-row">
              <span className="num">1,166</span>
              <span className="label">
                downloads of our developer kit, with no paid marketing behind it
              </span>
            </div>
            <div className="deck-evidence-row">
              <span className="num">50/50</span>
              <span className="label">
                payments settled at once without a single collision. We first proved the old way
                broke, managing 1 out of 50, then fixed it
              </span>
            </div>
            <div className="deck-evidence-row">
              <span className="num">✓</span>
              <span className="label">
                Real payments, on a real chain, with receipts anyone can look up. Not a prototype
                and not a simulation
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 12
  {
    id: "audit-yourself",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">The number we are proudest of</p>
        <h2>
          We built the thing <em>that can prove us wrong.</em>
        </h2>
        <p className="deck-body">
          Our public explorer watches every machine payment on Stellar, not only ours. Of everything
          it has counted, the share that is us:
        </p>
        <p className="deck-headline-number">4.5%</p>
        <div className="deck-chips">
          <span>352 settled by Vellar</span>
          <span>7,398 by everyone else</span>
          <span>we are 1 in 22</span>
        </div>
        <p className="deck-body" style={{ marginTop: "2rem" }}>
          We could have built a dashboard that only ever shows our own traffic and looks enormous.
          Instead we built the referee, and it says we are small. That is exactly how you know the
          other 95.5% is real, and how big the room to grow is.
        </p>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 13
  {
    id: "use-of-funds",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">What the funding does</p>
        <h2>
          Five things, <em>in order.</em>
        </h2>
        <div className="deck-milestones deck-milestones--five">
          <div className="deck-milestone deck-card--lime">
            <h4>Harden the infrastructure</h4>
            <p>
              Everything is running. Funding turns running into dependable: monitoring, redundancy
              and the operational maturity a payment rail is held to.
            </p>
            <span className="deck-milestone-num">1</span>
          </div>
          <div className="deck-milestone deck-card--mint">
            <h4>Go live on mainnet</h4>
            <p>
              Real payments with real money, not the test network. The engineering is done. What
              remains is the cost and care of running money in production.
            </p>
            <span className="deck-milestone-num">2</span>
          </div>
          <div className="deck-milestone deck-card--sun">
            <h4>Independent security audit</h4>
            <p>
              An outside firm reviewing financial infrastructure before it holds anyone else&rsquo;s
              money. We gate mainnet behind this rather than shipping first and auditing later.
            </p>
            <span className="deck-milestone-num">3</span>
          </div>
          <div className="deck-milestone deck-card--lime">
            <h4>Hire the team</h4>
            <p>
              One person built all of this. The next stage needs engineers on the rail and someone
              owning developer relations, so the roadmap stops being one person&rsquo;s calendar.
            </p>
            <span className="deck-milestone-num">4</span>
          </div>
          <div className="deck-milestone deck-card--mint">
            <h4>Go to market</h4>
            <p>
              Getting sellers onto the catalogue and buyers spending through it. The product works;
              distribution is the next problem, and it is the one funding solves fastest.
            </p>
            <span className="deck-milestone-num">5</span>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 14
  {
    id: "founder",
    content: (
      <div className="deck-slide-inner">
        <p className="deck-eyebrow">Who is building it</p>
        <div className="deck-founder">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="deck-founder-photo" src="/david.jpg" alt="David Ejere" />
          <div className="deck-founder-copy">
            <p className="deck-team-name">David Ejere</p>
            <p className="deck-team-role">Systems engineer &middot; Founder</p>
            <p className="deck-body">
              A systems engineer. I build the infrastructure other people&rsquo;s products run on:
              payment rails, wallets, the plumbing that has to work every time or nothing above it
              does.
            </p>
            <p className="deck-body">
              A Stellar Fellowship member, and a significant contributor to the ecosystem&rsquo;s
              leading projects: KindFi, Boundless and Trustless Work.
            </p>
            <p className="deck-body">
              I also build for African users directly. Teaketer is a fully open-source Nigerian
              ticketing platform where organisers are paid within 24 hours instead of waiting weeks,
              and I take nothing. Same instinct as Vellar: money that should already have moved,
              moving.
            </p>
            <div className="deck-ribbon">
              Vellar is six repositories, seven live services and a working payment rail, built
              alone, unfunded. The next stage is not proving it works. It is scale.
            </div>
          </div>
        </div>
      </div>
    ),
  },
  // ---------------------------------------------------------------- 15
  {
    id: "close",
    content: (
      <div className="deck-slide-inner">
        <div className="deck-logo-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Vellar" />
        </div>
        <h1>
          Software is starting to buy and sell. <em>We run the marketplace.</em>
        </h1>
        <p className="deck-lead">
          A marketplace of machine buyers and machine sellers is forming right now, in public, and
          we can already count it. Vellar takes a fee on every payment that crosses it, pays the
          developers who supply it, and lets anyone audit the whole thing from outside.
        </p>
        <div className="deck-ribbon">
          The conversation worth having is what this becomes with a partner who has done it before.
        </div>
        <div className="deck-chips deck-chips--links">
          <a href="https://www.vellar.xyz" target="_blank" rel="noreferrer">
            vellar.xyz
          </a>
          <a href="https://explorer.vellar.xyz" target="_blank" rel="noreferrer">
            explorer.vellar.xyz
          </a>
          <a href="mailto:david@vellar.xyz">david@vellar.xyz</a>
        </div>
      </div>
    ),
  },
];
