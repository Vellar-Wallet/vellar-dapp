"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Wraps the deck in a fixed 1600x900 stage and scales it down (never up)
 * to fit whatever window it's actually viewed in — like presenter view in
 * PowerPoint/Keynote. The deck's internal layout is built for that fixed
 * canvas (matches deck.css's print @page size); below ~1050px width,
 * content that should stack vertically has nowhere to go and runs past
 * the bottom with no scroll. Scaling the whole stage sidesteps that
 * instead of making every internal layout independently responsive.
 */
const STAGE_W = 1600;
const STAGE_H = 900;

export function ScaleToFit({ children }: { children: React.ReactNode }) {
  const [scale, setScale] = useState(1);
  const outerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function recalc() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const next = Math.min(vw / STAGE_W, vh / STAGE_H, 1);
      setScale(next);
    }
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, []);

  return (
    <div
      ref={outerRef}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
      }}
    >
      <div
        style={{
          width: STAGE_W,
          height: STAGE_H,
          flexShrink: 0,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          position: "relative",
        }}
      >
        {children}
        {/* Outside .deck-chrome (which print hides) so the wordmark survives
            PDF export, not just the on-screen presenter view. One instance,
            positioned over the fixed stage, appears identically on every
            slide instead of six duplicated <img> tags in slides.tsx. */}
        <img src="/logo-mark.png" alt="Vellar" className="deck-corner-logo" />
      </div>
    </div>
  );
}
