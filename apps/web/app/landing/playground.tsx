import { Chips, Frame, LpButton, MonoRow, MonoRows, SectionHead } from "./ui";

const LABS = [
  {
    tone: "mint",
    title: "Learn the flow",
    body: "Make a real API payment and inspect every hop, the 402 challenge, the signed header, the settled 200.",
  },
  {
    tone: "coral",
    title: "Break payments",
    body: "Five deliberate corruptions of a real signed payment, every one refused by the facilitator.",
  },
  {
    tone: "lime",
    title: "The Bazaar, live",
    body: "Browse every resource the facilitator has observed, each one with a working pay button.",
  },
  {
    tone: "sun",
    title: "Quest mode",
    body: "A five-level challenge track through everything above.",
  },
] as const;

/** Playground — a real, live testnet instance you can try without
 *  installing anything, framed around the break-it labs. */
export function Playground() {
  return (
    <section className="lp-sec" id="playground">
      <div className="lp-wrap">
        <SectionHead
          eyebrow="Playground"
          title={
            <>
              Don&apos;t take our word for it, <em>go break it.</em>
            </>
          }
          lead="A playground for external developers to visually try out the Vellar x402 payment facilitator on Stellar testnet. Get a real funded testnet account, then work through the lessons below, real settlements, real refusals, everything inspectable."
        />
        <div className="lp-play" data-reveal-group>
          <div className="lp-playgrid">
            {LABS.map((l) => (
              <div className={`lp-playcard lp-playcard--${l.tone}`} key={l.title}>
                <h4>{l.title}</h4>
                <p>{l.body}</p>
              </div>
            ))}
          </div>
          <Frame corner="br" color="coral">
            <div className="lp-pcard">
              <div className="lp-pcard-top">
                <span>Break payments, live · Example</span>
                <span>⌁</span>
              </div>
              <Chips
                items={[
                  { label: "Tamper signature", on: true },
                  { label: "Reuse nonce" },
                  { label: "5 corruptions total" },
                ]}
              />
              <MonoRows>
                <MonoRow label="GET /v1/research" value="402" tone="bad" />
                <MonoRow label="X-PAYMENT header" value="tampered" tone="bad" />
                <MonoRow label="facilitator verify" value="✗ refused" tone="bad" />
                <MonoRow label="funds moved" value="0.00" tone="ok" />
              </MonoRows>
              <span className="lp-verified">Nothing charged, that&apos;s the point</span>
            </div>
          </Frame>
        </div>
        <div className="lp-cta-row" data-reveal>
          <LpButton href="https://playground.vellar.xyz/" variant="sun">
            Open the playground →
          </LpButton>
        </div>
      </div>
    </section>
  );
}
