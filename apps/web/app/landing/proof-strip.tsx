import { SectionHead } from "./ui";

const PROOFS = [
  {
    label: "Listed in Stellar's docs",
    value: "Community facilitator",
    href: "https://developers.stellar.org/docs/build/agentic-payments/x402#community-facilitators",
  },
  {
    label: "On-ledger proofs",
    value: "15 verified testnet tx",
    href: "https://docs.vellar.xyz/docs/reference/proofs",
  },
  {
    label: "Canonical e2e suite",
    value: "6 settlements, stock clients",
    href: "https://docs.vellar.xyz/docs/reference/proofs",
  },
  {
    label: "Mainnet",
    value: "First payments settled Sept 2026",
    href: "https://docs.vellar.xyz/docs/reference/proofs",
  },
] as const;

type Proof = (typeof PROOFS)[number];

/** How many times the four proofs repeat inside one half of a track. The
 *  loop translates by exactly -50%, so each half must be wider than the
 *  120vw band or a gap shows at the seam: four 18rem cards are ~1.3k px,
 *  so two repeats clear any desktop width. */
const REPEATS = 2;

function ProofCard({ p, clone }: { p: Proof; clone: boolean }) {
  return (
    <a
      className="lp-proofcard lp-proofcard--marquee"
      href={p.href}
      target="_blank"
      rel="noreferrer"
      // Clones (and the whole decorative row) exist only for the visual
      // loop. Hidden from assistive tech and out of the tab order, so a
      // keyboard user meets each link exactly once.
      aria-hidden={clone || undefined}
      tabIndex={clone ? -1 : undefined}
    >
      <span className="lp-proofcard-label">{p.label}</span>
      <span className="lp-proofcard-value">{p.value}</span>
      <span className="lp-proofcard-go" aria-hidden="true">
        Verify &rarr;
      </span>
    </a>
  );
}

/** One marquee row. The visible half is rendered REPEATS times; the whole
 *  half is then duplicated so the track can loop by -50%. */
function MarqueeRow({
  items,
  direction,
  seconds,
  decorative = false,
}: {
  items: readonly Proof[];
  direction: "forward" | "reverse";
  seconds: number;
  /** A purely visual repeat of another row: every card is hidden from
   *  assistive tech and the tab order, so each proof is announced once. */
  decorative?: boolean;
}) {
  const half = Array.from({ length: REPEATS }, () => items).flat();
  return (
    <div
      className={`lp-marquee lp-marquee--${direction}`}
      style={{ animationDuration: `${seconds}s` }}
    >
      {[false, true].flatMap((clone) =>
        half.map((p, i) => (
          <ProofCard
            key={`${clone ? "c" : "o"}-${i}`}
            p={p}
            clone={decorative || clone || i >= items.length}
          />
        )),
      )}
    </div>
  );
}

/** Proof strip: the track record, as the reference spec's tilted dual
 *  marquee. Two rows drift in opposite directions at different speeds
 *  (20s and 25s, spec values), the second offset so the cards never line
 *  up. Every card still links straight to the ledger or doc that backs it.
 *
 *  Pure CSS, so this stays a server component. Under reduced motion the
 *  band untilts, stops, drops its clones and wraps into a plain grid; the
 *  loop also pauses on hover and focus, since a moving link is hard to
 *  click. */
export function ProofStrip() {
  return (
    <section className="lp-sec lp-sec--proof" id="proof" aria-label="Verifiable proofs">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="Track record"
          title={
            <>
              Not a pitch.
              <br />
              <em>A paper trail.</em>
            </>
          }
          lead="Every line below links to the ledger, the doc, or the repo that proves it. Nothing here is asserted without something you can go check yourself."
        />
      </div>
      <div className="lp-marquee-stage">
        <div className="lp-marquee-band">
          <MarqueeRow items={PROOFS} direction="forward" seconds={20} />
          <MarqueeRow items={[...PROOFS].reverse()} direction="reverse" seconds={25} decorative />
        </div>
      </div>
    </section>
  );
}
