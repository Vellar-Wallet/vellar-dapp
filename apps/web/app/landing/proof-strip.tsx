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

/** Small linked proof strip: every claim on the page is checkable, and
 *  this is where you go check it. Reuses the pillar-card visual language
 *  at a lighter weight. */
export function ProofStrip() {
  return (
    <section className="lp-sec lp-sec--tight" aria-label="Verifiable proofs">
      <div className="lp-wrap">
        <div className="lp-proofstrip" data-reveal-group>
          {PROOFS.map((p) => (
            <a className="lp-proofcard" href={p.href} key={p.label}>
              <span className="lp-proofcard-label">{p.label}</span>
              <span className="lp-proofcard-value">{p.value}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
