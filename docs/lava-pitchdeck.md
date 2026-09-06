# Vellar, Pitch Deck for LAVA

Copy and pagination only, for building on your own domain against the existing
Vellar design system. Not a business plan, this is the deck. **No investment ask
in this version** — this is a first-conversation deck, built to earn the second
meeting, not to close a round.

## Who this is written for, and what that changed

LAVA is an operator-led fund for Africa's Web3 and stablecoin ecosystem,
investing $100k–$500k at pre-seed through pre-Series A. Their thesis has three
pillars, stated in their own words:

1. **Trust Infrastructure** — "identity, reputation, on-chain data,
   attestations, ownership rights"
2. **Simple Finance** — "payments, on/off-ramps, local stablecoins, wallets,
   credit, savings, escrow, insurance, FX"
3. **AI as Leverage** — "AI catalyzing productivity, distribution, and
   underwriting across the financial and trust stack"

Vellar sits on the intersection of all three, which almost nothing does. That is
the single most important fact about this deck, and it belongs on page one.

Three deliberate changes from the Oakvale deck:

- **The ask is gone.** Replaced by a page on what the next twelve months look
  like and what a partner would be joining. The close asks for a conversation.
- **The frame is trust infrastructure and payment rails**, not "agent payments."
  LAVA funds attestations, verification and settlement. Vellar *is* an
  attestation registry and a settlement layer that happens to serve agents.
  Leading with the agent framing sells the least LAVA-shaped part of the story.
- **Africa is addressed honestly, and early.** LAVA is Africa-focused and this
  is a solo founder in Nigeria building global infrastructure. Pretending the
  product is Africa-specific would be a lie they would catch. The honest version
  is stronger, and it is page 3.

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

**Recommendation for this deck specifically:** paper light mode as the default,
presented live on a call. Forest and ink for structure, lime reserved for exactly
one number or claim per slide, the thing you want the room to remember. Do not
let lime become decorative, it loses its weight the moment it appears twice on
the same slide.

**Every number in this deck was pulled live on 2026-09-05, not carried over from
the previous deck.** Where a number moved, this deck uses the new one. Sources
are in the appendix at the end so nothing on a slide has to carry a citation.

Every slide below is one page. A horizontal rule marks the page break.

---

## Page 1 — Title

`[VELLAR LOGO, top left]` `[LAVA LOGO, top right]`

Vellar

**Trust infrastructure for money** *that moves itself.*

Attestations, spending policies and settlement on Stellar, so software can be
given a budget instead of a key. Passkeys, not seed phrases. Verification anyone
can check from the outside.

Prepared for LAVA, September 2026

---

## Page 2 — Where this sits

LAVA invests along three pillars. Most companies sit on one.

**Trust infrastructure.** Vellar runs an on-chain attestation registry and a
trust layer that ranks a service by real settlement history and verified source
code, not by self-description.

**Simple finance.** Stablecoin payments that settle on Stellar in seconds for
fractions of a cent, with the fee sponsored so the payer never needs to hold the
native token first.

**AI as leverage.** The payer is software. That is not a feature bolted on, it
is the reason the other two pillars had to be built the way they were.

`[Set the three pillar names in lime. Nothing else on this slide takes lime.]`

One company, all three, load-bearing. That intersection is the whole thesis.

---

## Page 3 — Said plainly, on Africa

You are an Africa-focused fund. Here is the honest version, before you ask.

Vellar is built in Nigeria, by a Nigerian founder, on the rail Africa already
uses most heavily for stablecoin settlement. It is not an Africa-only product,
and claiming it was would not survive your diligence.

What is true is more useful than that. The thing that makes autonomous payments
hard everywhere — no card, no chargeback, no bank in the loop, settlement that
has to be final and cheap and instant — describes the African payments context
before it describes anyone else's. Stablecoin rails were not a workaround here,
they were the first thing that worked.

Software that pays for what it uses, with a budget enforced beneath it, is
infrastructure a market without a consumer card layer needs sooner than a market
with one. LAVA's own words for what you back: solutions "that work in African
contexts and travel to other emerging markets."

That is the claim. Not that Vellar is African infrastructure by geography, but
that this problem gets solved here first because here is where the constraint is
real.

---

## Page 4 — The problem

Software can already move a token from one address to another. It cannot yet do
three things that autonomous software actually needs.

**Discover.** Software can only pay an endpoint it already knows about. There is
no open catalog it can search.

**Spend safely.** A spending limit enforced by the payer's own client code is
only as safe as that code. Compromise the client, the limit disappears with it.

**Verify.** Nothing checks whether a facilitator's own claim about what it
settled is actually true. The payer is asked to trust a party with every
incentive to look good.

Developers can settle a simple transfer today. They cannot yet build software
that finds a service, stays inside a budget the chain itself enforces, and can
prove what actually happened. That gap is what Vellar closes.

---

## Page 5 — The thesis

Autonomous software holds a key. That key cannot spend past its budget, not
because the software says so, not because a facilitator promises it, but because
the blockchain itself refuses the transaction.

A fourth, unrelated party can check the entire chain of that claim from the
outside, trusting none of the pieces above it.

That is not a feature sitting on top of a payments product. It is the
architecture.

---

## Page 6 — How it works, proven in four places

Four separate systems, each proving one piece of the same claim, independently.

**The wallet mints the budget.** A passkey secured smart account attaches a
spending policy enforced on chain. Proven live, a payment under budget settles,
the identical mechanism over budget is rejected by the chain itself before
anything moves.

**The SDK is what the payer actually holds.** A scoped session key signs
headlessly, no human, no browser, no prompt. Tested end to end against a real
0.5 USDC on chain cap, with the software's own internal limits deliberately set
higher than that cap. A payment under the cap settled on real testnet
infrastructure. The identical payment over the cap was refused by the chain
itself, before a transaction was even submitted. Only the chain stopped it.

**The facilitator never trusts what it is told.** It re-simulates every payment
against the live chain before settling, and hosts Bazaar, the discovery layer
software searches instead of needing a hardcoded URL.

**The explorer trusts none of the above.** A separate, independently operated
service that reads the ledger directly and refuses to trust even a facilitator's
own claimed settlement amount, reading the token's own on chain event instead.

No single piece tells this story alone. Put together, spending is capped by a
mechanism that does not trust its own client, does not trust the facilitator's
self report, and can be checked from outside by a fourth party that trusts
neither.

---

## Page 7 — Both sides of the marketplace

A catalog is only as good as how easily a seller can get into it. Buyers were
the harder engineering problem. Sellers are the harder distribution problem, and
that one is now shipped too.

**Listing requires no signup.** A resource enters Bazaar automatically the
moment a real payment settles against it. The catalog builds itself out of
things that actually worked.

**A seller can list from inside their editor.** The Vellar VS Code extension is
published and live, at version 0.2.3. A developer scaffolds a paid endpoint,
activates it and lists it without leaving the file they were already writing.
Since the last time this deck was written, this went from roadmap to shipped.

**Agents can reach the catalog from inside a web page.** A WebMCP server exposes
six tools, three core and three generated live from the Bazaar catalog itself.

Three ways in, for the three places a seller actually lives.

---

## Page 8 — Why AI is not a feature here

Take the autonomous payer out of this picture, and two of the hardest things
built here would have no reason to exist.

**The catalog defends against its own reader.** A seller writes the description
of what they are selling. Software reads it and decides what to do. That makes
the catalog an attack surface the moment the reader is a model, not a person,
since a listing can be written specifically to manipulate that reader into
overpaying or paying the wrong party. Every listing is fenced as untrusted data
before it ever reaches a model's reasoning, the same fence, independently
implemented twice, once on the discovery side and once on the payer side, kept
in sync on purpose.

**Discovery speaks the language software already speaks.** Not a website with an
API bolted on, an MCP server, the same tool calling interface a model's own
reasoning loop already uses for everything else.

**The honesty is repeated on purpose.** Verified does not mean safe. That exact
phrasing appears independently, in the same words, in two different parts of the
stack, because a real security boundary and a mere reputation signal must never
be confused, especially by a model deciding whether to spend.

---

## Page 9 — Evidence, not claims

Every number below is checkable, not asserted. All pulled live on 2026-09-05.

`1,166` real downloads of the published SDK, no paid distribution

`613` facilitator tests passing, `4` skipped, types clean. Across the whole
stack, `1,223` TypeScript tests and `189` Rust contract tests

`50 / 50` concurrent settlements with zero sequence-number collisions. The
single-signer control arm on the identical run, `1 / 50`. The negative control
was run on purpose, because a number without one proves nothing

Real settlement transaction hashes, independently confirmed on chain, not
simulated

`11` live operational metrics on a public endpoint, forwarded to Grafana

Many tests carry an explicit note naming the mutation that must break them, so
a reverted fix fails a test rather than passing quietly

---

## Page 10 — The number that matters most

A separately operated public explorer watches the entire visible Stellar x402
ecosystem, not only Vellar's own traffic.

`7,725` payments indexed. `557` distinct buyers. `525` distinct sellers.

Of all of it, Vellar is attributed `4.5%`.

`[This is the lime number on this slide. The 4.5%, not the 7,725.]`

The other `95.5%` is third party activity it found on its own, with no
relationship to us.

That is the proof it audits the ecosystem rather than mirroring us. A verifier
that only ever sees its own operator's traffic is not a verifier, it is a
dashboard. This one is measurably neither flattering nor blind, and the number
that proves it is the smallest one on the page.

---

## Page 11 — Competitive position

Not trying to be the only facilitator on Stellar. Healthy competition is good
for the ecosystem, and worth saying plainly.

What Vellar believes it is, today, is the only one with all of the following at
once: an open discovery catalog, a payer-facing interface on both sides of a
transaction, payments gated on verified provenance, and independent external
verification of what actually settled.

There are also three compatibility findings worth naming, because they are a
moat that was earned by hitting them. Testing against other deployed
facilitators surfaced real defects in how the ecosystem handles smart-account
payments: a fee ceiling that rejects any payment carrying an on-chain spending
policy, a credential-type gap that blocks passkey-signed payments across the
ecosystem entirely, and a settlement path that discards the chain's own
submission status so a retryable failure is indistinguishable from a fatal one.
All three were reproduced empirically. Two are filed upstream as public issues
against the x402 standard.

Payments that other facilitators refuse settle here.

Finding those required building the payer side first. That is not a position
that can be reached by starting from the facilitator.

---

## Page 12 — Addressed directly

Three real gaps, stated plainly rather than left for diligence to find.

**One founder built this.** Every repository, every contract, every audit finding
fixed, alone. Six repositories, seven live services, six Soroban contracts, two
published packages. That is not a story about limits, it is evidence of what one
person executes without funding. Adding hands is the obvious next step, and the
concentration risk is real until then — today one person holds every key, every
deploy credential and every publish right in the stack.

**No external audit exists yet, and everything is still testnet.** What exists
is real: two internal security reviews totalling nearly three thousand lines,
one returning an explicit no-go for mainnet on its own findings, 32 findings
closed by a test that fails if the fix is reverted, 4 still open and named. What
has never happened is a third party firm checking that work. Mainnet is
deliberately gated behind that audit rather than shipped ahead of it, and until
one real payment settles on pubnet, this is sophisticated testnet infrastructure
rather than a live payment rail. Every code prerequisite is merged; what remains
is operational.

**Revenue is not proven.** The rails are live, the ecosystem is measurably real
and it is not yet monetized. The honest position is that the business model
question is open, and pretending otherwise would waste your time and mine.

`[Coral appears on this slide and nowhere else in the deck.]`

---

## Page 13 — Team

**David Ejere**, Fullstack and Blockchain Engineer, Founder.

Five plus years across fullstack and blockchain development. Former Stellar
Fellowship member and open source contributor across the ecosystem, including
KindFi, Boundless, and Trustless Work, and winner of Best Technical Integration
at the Boundless x Trustless Work Hackathon.

Built and currently leads all of it. The passkey smart wallet and on chain
spending policies published as `vellar-sdk` on npm, six Soroban contracts
covering the attestation registry and three spending-policy templates, the x402
facilitator with its discovery layer and agent facing interfaces, the
independent explorer, the WebMCP surface, the interactive playground, and the
published editor extension.

---

## Page 14 — What the next twelve months look like

Four things, in order, each finishable and checkable on its own.

**Harden what is already live.** The infrastructure is running. Operational
maturity is the difference between running and dependable.

**Close the two known verification gaps.** Both are already documented in public,
with a named owner and a test that will prove the close.

**Contribute the metered payment scheme upstream to the x402 standard.** Work
that benefits the ecosystem rather than only Vellar, and the fastest way for a
small team to matter more than its headcount.

**Mainnet, gated on the external audit.** Not before it.

`[Set the word "gated" in lime. It is the point of the slide.]`

---

## Page 15 — Close

Vellar is trust infrastructure for money that moves itself, on the rail that
already settles most of Africa's stablecoin volume. It is on chain, checked from
outside by a service that has no reason to flatter it, and built by one founder
who has already shipped the part most teams are still pitching.

The conversation worth having is what this becomes with a partner who has done
it before.

`[VELLAR LOGO]`

`vellar.xyz`, `docs.vellar.xyz`, `explorer.vellar.xyz`, `david@vellar.xyz`

---

## Appendix — where every number comes from

Not a slide. Reference material, so nothing on a page has to carry a citation
and so every figure can be re-checked before the meeting.

| Claim on slide | Value | Verify it |
| --- | --- | --- |
| SDK downloads | 1,166 all-time, 627 in the last 30 days | `curl https://api.npmjs.org/downloads/range/2025-01-01:2026-09-05/vellar-sdk` |
| Facilitator tests | 613 passing, 4 skipped, typecheck clean | `npm test` in `vellar-facilitator` |
| Concurrency | 50/50 settled, 0 `txBadSeq`, p95 11,956 ms; control arm 1/50 with 48 `txBadSeq` | `load-test-results-2026-08-31T11-15-47-630Z.json`, commit `6f5de85` |
| Live metrics | 11 named `vellar_*` metrics | `curl -s https://vellar-facilitator.onrender.com/metrics \| grep -c '^# HELP vellar_'` |
| Ecosystem totals | 7,725 payments, 557 buyers, 525 sellers | `curl https://vellar-explorer.onrender.com/stats` |
| Vellar's share | 348 of 7,725 = 4.5% | same endpoint, `facilitatorBreakdown` |
| Catalog size | 12 live resources | `curl https://vellar-facilitator.onrender.com/health` |
| Channel pool | 50 channels, all available | same endpoint, `channelPool` |
| VS Code extension | v0.2.3 published, 2 installs, 160 downloads | marketplace `extensionquery` API for `VellarWallet.vellar-x402` |
| WebMCP | 6 tools, 3 core + 3 generated from the catalog | `vellar-webmcp.onrender.com` |
| Fee-ceiling defect | ~139,500 stroops for a policy-governed payment vs a 50,000 default ceiling; `MAX_TX_FEE_STROOPS` ships at 500,000 | `docs/decision-fee-thresholds.md` in the facilitator repo |
| Credential-type gap | passkey-kit 0.14 cannot emit type-1 credentials; deployed facilitators reject type-2 | facilitator `technical-doc.md` §2 |

**What changed since the Oakvale deck, and why this deck uses the new numbers.**
SDK downloads moved 1,110 → 1,166. Facilitator tests moved 514 → 613, which
understated us. The ecosystem share moved 4.4% → 4.5%, the most interesting of
the three: the ecosystem grew and Vellar's share of it stayed flat, exactly what
an honest external verifier should show.

**One claim was removed rather than updated.** The Oakvale deck said a scheduled
probe settles real payments five times a day. That stopped being true on
2026-08-31: the channel pool made `CHANNEL_ACCOUNT_SECRET_KEYS` a required
variable with no default, the probe workflow was never given it, and the
facilitator has refused to boot in CI on every run since — 23 consecutive
failures. The claim is out of this deck until the probe is green again, at which
point it is worth putting back, because the control arm makes it good evidence.

**Re-pull before the meeting.** The explorer stats on page 10 move daily. Check
the settle probe's status too — if it is fixed and has run clean for a week, add
it back to page 9.
