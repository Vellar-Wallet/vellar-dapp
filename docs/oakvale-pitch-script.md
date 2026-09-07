# Oakvale pitch — speaking script

13 slides. Say this, don't read it — each block is what to _say_, not what's on
the slide. Keep pace: this whole thing should run 6-8 minutes before questions.

---

**1. Title**
"Vellar is the agent payments stack for Stellar. Smart accounts that pay for
things autonomously, with a budget the blockchain itself enforces — not the
agent's own code."

**2. The problem**
"Right now an AI agent can't do three things: find a service to pay for,
spend inside a safe limit, or prove what it actually paid. We built all three."

**3. The thesis**
"The core idea: an agent's spending limit isn't a setting in our software —
it's enforced by the blockchain itself. Even if you hack the agent, you can't
make it overspend. And a fourth, separate party can check that from outside."

**4. How it works, proven in four places**
"Four independent systems back this up. The wallet enforces the budget on
chain. The SDK is what the agent actually holds and signs with — no human in
the loop. The facilitator double-checks every payment against the chain
before settling. And a separate public explorer verifies the facilitator
itself, trusting nobody. That's the whole chain of trust, proven end to end."

**5. The other side of the marketplace**
"Buying is only half of it. Selling is already live — list a paid API or tool,
and it shows up automatically the moment someone pays for it. Next: a
developer tool that makes listing take zero extra work."

**6. Why AI is not a feature here**
"Take the AI agent out of this picture and two of our hardest problems
disappear. The catalog has to defend against a model reading it, discovery
has to speak an AI's native interface, not a website — and we're honest
everywhere that 'verified' doesn't mean 'safe.'"

**7. Evidence, not claims**
"Everything here is checkable. 1,110 real npm downloads, zero paid marketing.
514 tests passing. Real transaction hashes anyone can look up. And an
independent public explorer — we're only 4.4% of what it's tracked, meaning
it's auditing the whole ecosystem, not just flattering us."

**8. Competitive position**
"We're not trying to be the only facilitator on Stellar — competition is
good. But today, we're the only one with open discovery, an agent-native
interface, provenance-gated payments, and independent verification, all at
once."

**9. Addressed directly**
"Two honest gaps, up front. One: I built this alone — that's not a
limitation, it's proof of what's possible without funding, and this round
adds hands. Two: no external audit yet — two internal reviews exist, one
failed on purpose to catch real issues, and this funding pays for the audit
directly."

**10. Team**
"That's me. Five-plus years building fullstack and blockchain software,
Stellar Fellowship alum, built every piece of this stack myself — the
wallet, the contracts, the facilitator."

**11. Roadmap**
"Four things this money buys: hardening what's live, closing the two gaps I
just named, contributing our payment scheme back to the x402 standard, and
launching on mainnet once the audit's done."

**12. The ask**
"We're asking for ZAR 1.611 million — about $100K. Over half goes straight
to engineering. Twenty percent is the audit. The rest is infrastructure and
finding our first real customers. Paid out in tranches, tied to each
milestone — not one lump sum."

**13. Close**
"Vellar is the safety layer under the agent economy on Stellar — already
proven on chain, already checked from outside. I'm not asking for money to
prove it works. I'm asking for the resources to do it faster."

---

### If asked

- **"Why hasn't this been audited yet?"** → Two internal reviews already done,
  one deliberately returned a no-go verdict, everything since fixed. This
  round funds the external one directly.
- **"What if a bigger player builds this?"** → We're not exclusive by design —
  healthy competition is good. Our edge today is doing all four things
  (discovery, governance, provenance, external verification) at once, which
  nobody else does yet.
- **"Solo founder — what's the risk?"** → Everything shipped, audited
  internally, and tested was built by one person with no funding. This round
  is explicitly to add hands, not replace the one who already delivered.
