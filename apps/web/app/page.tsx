import { LpShell } from "./landing/shell";
import { Hero } from "./landing/hero";
import { X402Pillars } from "./landing/pillars";
import { TraceSection } from "./landing/trace";
import { ProofStrip } from "./landing/proof-strip";
import { TwoSides } from "./landing/platforms";
import { VsCodeExtension } from "./landing/vscode";
import { Playground } from "./landing/playground";
import { FaqSection } from "./landing/faq";
import { SdkCta } from "./landing/cta";

// Marketing landing — "paper & signals" system. Sections and shared
// primitives live in app/landing/ (styling in landing.css, imported by
// the shell). The product app at /app keeps the dark VELA system and is
// intentionally not linked from this marketing surface.

export default function Landing() {
  return (
    <LpShell>
      <Hero />
      <X402Pillars />
      <TraceSection />
      <ProofStrip />
      <TwoSides />
      <VsCodeExtension />
      <Playground />
      <FaqSection />
      <SdkCta />
    </LpShell>
  );
}
