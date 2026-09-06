import type { Metadata } from "next";
import "../landing/landing.css";
import "./deck.css";
import { DeckView } from "./deck-view";

export const metadata: Metadata = {
  title: "Vellar × Oakvale Invest",
  description: "Vellar pitch deck, prepared for Oakvale Invest.",
  robots: { index: false, follow: false, nocache: true },
};

export default function OakvaleDeckPage() {
  return <DeckView />;
}
