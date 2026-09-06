import type { Metadata } from "next";
import "../landing/landing.css";
import "../oakvale/deck.css";
import "./founder.css";
import { DeckView } from "../oakvale/deck-view";
import { SLIDES } from "./slides";

export const metadata: Metadata = {
  title: "Vellar × LAVA",
  description: "Vellar pitch deck, prepared for LAVA.",
  robots: { index: false, follow: false, nocache: true },
};

export default function LavaDeckPage() {
  return <DeckView slides={SLIDES} downloadLabel="Download PDF" />;
}
