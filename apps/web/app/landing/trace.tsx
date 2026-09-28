import { Eyebrow } from "./ui";

const ROWS = [
  { label: "GET /v1/research", value: "402", tone: "bad" },
  { label: "price", value: "0.05 USDC" },
  { label: "/verify", value: "✓ valid", tone: "ok" },
  { label: "/settle", value: "✓ fee sponsored", tone: "ok" },
  { label: "resource", value: "200 OK", tone: "ok" },
] as const;

/** The pinned 402 → 200 moment: motion.tsx scrubs the rows and the
 *  progress bar via the data-trace* hooks while the section is pinned. */
export function TraceSection() {
  return (
    <section className="lp-trace lp-invert" data-trace>
      <div className="lp-wrap lp-trace-pin" data-trace-pin>
        <div className="lp-trace-grid">
          <div>
            <Eyebrow>One request, end to end</Eyebrow>
            <h2 className="mt-[var(--lp-sp-4)]!">
              An agent hits a paywall. <em>Vellar settles it.</em>
            </h2>
            <p className="lp-lead">
              The resource server returns 402 with a payment challenge. The agent signs a payment
              authorization and retries. Vellar verifies the signature, settles the transaction on
              Stellar, and sponsors the network fee, then the resource server returns 200.
            </p>
          </div>
          <div className="lp-trace-panel">
            <div className="head">
              <span>buyer → seller · x402</span>
              <span>402 → 200</span>
            </div>
            {ROWS.map((r) => (
              <div className="lp-trace-row" data-trace-row key={r.label}>
                <span>{r.label}</span>
                <b className={"tone" in r ? r.tone : undefined}>{r.value}</b>
              </div>
            ))}
            <div className="lp-trace-bar">
              <i data-trace-bar />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
