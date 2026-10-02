import { LpShell } from "./landing/shell";
import { HeroScene, Curtain } from "./landing/scenes";
import { Hero } from "./landing/hero";
import { X402Pillars } from "./landing/pillars";
import { TraceSection } from "./landing/trace";
import { ProofStrip } from "./landing/proof-strip";
import { TwoSides } from "./landing/platforms";
import { VsCodeExtension } from "./landing/vscode";
import { Playground } from "./landing/playground";
import { FaqSection } from "./landing/faq";
import { SdkCta } from "./landing/cta";

// Marketing landing — "paper & signals" tokens on a staged, sticky-scene
// layout. Sections and shared primitives live in app/landing/ (styling in
// landing.css, imported by the shell); the layering mechanics are in
// scenes.tsx. The product app at /app keeps the dark VELA system and is
// intentionally not linked from this marketing surface.
//
// Structure (reference spec §3.2, re-choreography recorded in
// docs/decisions.md): the hero is a sticky scene that shrinks and tilts
// away while everything after it rises as one curtain with a diagonal top
// edge. The trace section is the pinned, scrubbed moment inside that
// curtain; the playground is a second curtain in the loud accent.

export default function Landing() {
  return (
    <LpShell>
      <div className="lp-staged">
        <HeroScene>
          <Hero />
        </HeroScene>

        <Curtain diagonal overlap>
          <X402Pillars />
          <TraceSection />
          {/* Rises over the trace scene's last viewport, so the scene's
              exit plays underneath it (reference spec §3.2). */}
          <Curtain>
            <ProofStrip />
            <TwoSides />
            <VsCodeExtension />
            <Playground />
            <FaqSection />
            <SdkCta />
          </Curtain>
        </Curtain>
      </div>
    </LpShell>
  );
}
