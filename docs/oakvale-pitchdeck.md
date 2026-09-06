# Vellar, Pitch Deck for Oakvale Invest

Copy and pagination only, for building on your own domain against the existing Vellar design system. Not a business plan, this is the deck.

## Design system reference (pulled live from vellar.xyz, not guessed)

**Type**
- Display, headlines and slide titles, italic weight: Playfair Display, weights 500, 600, 700
- Body and UI, everything else: Plus Jakarta Sans, weights 400 through 800
- Utility, numbers, code, data labels, evidence rows: Space Mono, weights 400 and 700
- Google Fonts import already in use on the site: `family=Playfair+Display:ital,wght@1,500;1,600;1,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700`

**Color, light mode**
- Ink, primary text: `#0c3b31`
- Ink soft, secondary text: `#0c3b31bd`
- Paper, background: `#fff`, paper tint `#f5f9f6`
- Forest, primary brand green: `#13594d`
- Lime, primary accent, use for the single boldest number or claim per slide: `#c8f048`, soft `#f0f9d2`
- Mint, secondary accent: `#3ee6ad`, soft `#dcf8ec`
- Coral, reserve for the one honest risk slide only, never decorative: `#ff6b5e`, soft `#ffe4e0`
- Sun, warm accent, sparing use: `#ffc94a`, soft `#ffefc9`
- Line, hairlines and dividers: `#0c3b3129`

**Color, dark mode**
- Background: `#060a09`
- Ink: `#eef2f0`
- Ink soft: `#eff5f2bd`
- Same lime, mint, coral, sun accents carry over unchanged

**Recommendation for this deck specifically:** paper light mode as the default, presented live on a call. Forest and ink for structure, lime reserved for exactly one number or claim per slide, the thing you want the room to remember. Do not let lime become decorative, it loses its weight the moment it appears twice on the same slide.

Every slide below is one page. A horizontal rule marks the page break.

---

## Page 1 — Title

`[VELLAR LOGO, top left]` `[OAKVALE LOGO, top right]`

Vellar

**Give your agent a budget,** *not your keys.*

The agent payments stack for Stellar. Smart accounts that pay HTTP 402 APIs autonomously, budgets enforced on chain, trust ranked discovery. Secured by passkeys, not seed phrases.

Prepared for Oakvale Invest, August 2026

---

## Page 2 — The problem

Software can already move a token from one address to another. It cannot yet do three things an autonomous agent actually needs.

**Discover.** An agent can only pay an endpoint it already knows about. There is no open catalog it can search.

**Spend safely.** A spending limit enforced by the agent's own client code is only as safe as that code. Compromise the client, the limit disappears with it.

**Verify.** Nothing checks whether a facilitator's own claim about what it settled is actually true. The agent is asked to trust a party with every incentive to look good.

Developers can settle a simple transfer today. They cannot yet build an agent that finds a service, stays inside a budget the chain itself enforces, and can prove what actually happened. That gap is what Vellar closes.

---

## Page 3 — The thesis

An autonomous agent holds a key. That key cannot spend past its budget, not because the agent's own software says so, not because a facilitator promises it, but because the blockchain itself refuses the transaction.

A fourth, unrelated party can check the entire chain of that claim from the outside, trusting none of the pieces above it.

That is not a feature sitting on top of a payments product. It is the architecture.

---

## Page 4 — How it works, proven in four places

Four separate systems, each proving one piece of the same claim, independently.

**The wallet mints the budget.** A passkey secured smart account attaches a spending policy enforced on chain. Proven live, a payment under budget settles, the identical mechanism over budget is rejected by the chain itself before anything moves.

**The SDK is what the agent actually holds.** A scoped session key signs headlessly, no human, no browser, no prompt. Tested end to end against a real 0.5 USDC on chain cap, with the software's own internal limits deliberately set higher than that cap. A payment under the cap settled on real testnet infrastructure. The identical payment over the cap was refused by the chain itself, before a transaction was even submitted. Only the chain stopped it.

**The facilitator never trusts what it is told.** It re simulates every payment against the live chain before settling, and hosts Bazaar, the discovery layer an agent searches instead of needing a hardcoded URL.

**The explorer trusts none of the above.** A separate, independently operated service that reads the ledger directly and refuses to trust even a facilitator's own claimed settlement amount, reading the token's own on chain event instead.

No single piece tells this story alone. Put together, an agent's spending is capped by a mechanism that does not trust its own client, does not trust the facilitator's self report, and can be checked from outside by a fourth party that trusts neither.

---

## Page 5 — The other side of the marketplace

Everything on the previous page is the buyer's side, an agent finding and paying for something. A catalog is only as good as how easily a seller can get into it.

Today, listing is already live and requires no separate signup, a resource is added to Bazaar automatically the moment a real payment settles against it.

What is coming next is a dedicated developer tool, a Vellar extension for the code editor a developer already works in, so listing a paid endpoint or a paid MCP tool takes no more effort than writing the endpoint itself. This is upcoming work, not yet shipped, and it is the third role in the system neither the wallet nor the facilitator alone covers, onboarding the people who supply what the catalog offers.

---

## Page 6 — Why AI is not a feature here

Take the autonomous agent out of this picture, and two of the hardest things we built would have no reason to exist.

**The catalog defends against its own reader.** A seller writes the description of what they are selling. An agent reads it and decides what to do. That makes the catalog an attack surface the moment the reader is a model, not a person, since a listing can be written specifically to manipulate that reader into overpaying or paying the wrong party. Every listing is fenced as untrusted data before it ever reaches an agent's reasoning, the same fence, independently implemented twice, once on the discovery side and once on the payer side, kept in sync on purpose.

**Discovery speaks the language an agent already speaks.** Not a website with an API bolted on, an MCP server, the same tool calling interface a model's own reasoning loop already uses for everything else.

**The honesty is repeated on purpose.** Verified does not mean safe. That exact phrasing appears independently, in the same words, in two different parts of the stack, because a real security boundary and a mere reputation signal must never be confused, especially by a model deciding whether to spend.

---

## Page 7 — Evidence, not claims

Every number below is checkable, not asserted.

`1,110` real npm downloads of the published SDK

`514` SDK tests passing, `0` failures

Real settlement transaction hashes, independently confirmed on chain, not simulated

A separately operated public explorer that watches the entire visible testnet ecosystem, not just our own traffic, its own numbers show only `4.4%` of everything it has indexed is attributed to us. The other `95.6%` is third party activity it found on its own. That is the proof it audits the ecosystem, not a mirror we built to flatter ourselves.

---

## Page 8 — Competitive position

We are not trying to be the only facilitator on Stellar. Healthy competition is good for the ecosystem, and we say so plainly.

What we believe we are, today, is the only one with all of the following at once, an open discovery catalog, an agent facing interface on both sides of a transaction, payments gated on verified provenance, and independent, external verification of what actually settled.

---

## Page 9 — Addressed directly

Two real gaps, stated plainly rather than left for diligence to find.

**One founder built this.** Every repository, every contract, every audit finding fixed, alone. That is not a story about limits, it is evidence of what one person can execute without funding. This round exists to add hands, not to replace the one that already shipped.

**No external audit exists yet.** What exists is real, two rigorous internal security reviews, one of them returning an explicit no go for mainnet verdict on its own findings, every finding since fixed and test backed. What has never happened is a third party firm checking that work. This funding names that audit as its own line item, not an afterthought bolted on at the end.

---

## Page 10 — Team

**David Ejere**, Fullstack and Blockchain Engineer, Founder.

Five plus years across fullstack and blockchain development. Former Stellar Fellowship member and open source contributor across the ecosystem, including KindFi, Boundless, and Trustless Work, and winner of Best Technical Integration at the Boundless x Trustless Work Hackathon.

Built and currently leads all of it. The passkey smart wallet and on chain spending policies published as `vellar-sdk` on npm, the Soroban contract suite behind the attestation registry and spending policies, and the x402 facilitator with its discovery layer and agent facing interfaces.

---

## Page 11 — Roadmap

Four deliverables, in order, each tied directly to a tranche of this round.

Operational hardening of the infrastructure already live.

Completing the trust and verification layer, closing the two gaps already known and documented.

An upstream contribution of the metered payment scheme to the x402 standard itself, work that benefits the whole ecosystem, not only us.

Mainnet launch, gated on the external security audit this round funds directly.

Beyond this round, a dedicated seller onboarding tool, the editor extension from the previous page, so listing a paid endpoint takes no more effort than writing it.

---

## Page 12 — The ask

**ZAR 1,611,000**, approximately $100,000 USD at the exchange rate current as of this writing.

`[The single largest number on the slide. Set in lime, Space Mono, tabular figures. Everything else on this page stays quiet around it.]`

Four categories, not a long list, this is what a reader needs to remember, not a full ledger.

**Product development, 55 percent.** Engineering time across every deliverable above.

**External security audit, 20 percent.** The one gap named on the previous page, funded directly rather than deferred.

**Infrastructure and operations, 15 percent.** Always on hosting, monitoring, the reliability a production payment rail actually requires.

**Early customers and go to market, 10 percent.** Finding design partners, documentation, the work of turning working infrastructure into something teams actually adopt.

Released as an approval payment plus four tranches, one per roadmap deliverable, not handed over in a single lump. A staged structure, not a single check, because the deliverables above are real and checkable one at a time.

---

## Page 13 — Close

Vellar is the safety layer underneath the agent economy on Stellar, proven on chain, checked from outside, built by one founder who is now asking for the resources to do it faster, not to prove it works for the first time.

`[VELLAR LOGO]`

Contact, links, and the live product, `vellar.xyz`, `docs.vellar.xyz`, `explorer.vellar.xyz`, `david@vellar.xyz`
