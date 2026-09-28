import { SectionHead } from "./ui";

const PROOFS = [
  {
    label: "Listed in Stellar's docs",
    value: "Community facilitator",
    href: "https://developers.stellar.org/docs/build/agentic-payments/x402",
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

/** Proof strip: the track record, made to be skimmed and checked in the same
 *  glance. Every card links straight to the ledger or doc that backs it, so
 *  this reads as evidence rather than a claim. Reuses the pillar-card color
 *  rotation so it carries the same weight as the "how it works" section. */
export function ProofStrip() {
  return (
    <section className="lp-sec" id="proof" aria-label="Verifiable proofs">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="Track record"
          title={
            <>
              Not a pitch. <em>A paper trail.</em>
            </>
          }
          lead="Every line below links to the ledger, the doc, or the repo that proves it. Nothing here is asserted without something you can go check yourself."
        />
        <div className="lp-proofstrip" data-reveal-group>
          {PROOFS.map((p) => (
            <a className="lp-proofcard" href={p.href} key={p.label}>
              <span className="lp-proofcard-label">{p.label}</span>
              <span className="lp-proofcard-value">{p.value}</span>
              <span className="lp-proofcard-go" aria-hidden="true">
                Verify &rarr;
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
