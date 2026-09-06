"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SLIDES, type Slide } from "./slides";

/**
 * The deck chrome — navigation, transitions, progress — is shared across every
 * deck. Only the slide content differs, so callers pass their own SLIDES array.
 * Defaults to the Oakvale deck's slides so existing callers keep working.
 */
export function DeckView({
  slides = SLIDES,
  /** When set, a Download PDF button appears in the deck chrome. It triggers the
   *  browser's own print dialog; the print stylesheet lays every slide out
   *  one-per-page, so "Save as PDF" produces the deck exactly as it renders. */
  downloadLabel,
}: {
  slides?: Slide[];
  downloadLabel?: string;
}) {
  const [active, setActive] = useState(0);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  const total = slides.length;
  const advancing = useRef(false);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total || next === active || advancing.current) return;
      advancing.current = true;
      setLeaving(active);
      setActive(next);
      window.setTimeout(() => {
        setLeaving(null);
        advancing.current = false;
      }, 560);
    },
    [active, total],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        goTo(active + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goTo(active - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        goTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        goTo(total - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, goTo, total]);

  // The deck mounts one slide at a time, so printing has to mount them all.
  // These fire for the button below and for a plain Cmd+P alike.
  useEffect(() => {
    const before = () => setPrinting(true);
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  const download = useCallback(() => {
    // Mount every slide, let the browser paint, then open the print dialog.
    setPrinting(true);
    window.setTimeout(() => window.print(), 80);
  }, []);

  return (
    <div className="lp deck">
      {slides.map((slide, i) => {
        const isActive = i === active;
        const isLeaving = i === leaving;
        if (!printing && !isActive && !isLeaving) return null;
        return (
          <section
            key={slide.id}
            className={["deck-slide", isActive ? "is-active" : "", isLeaving ? "is-leaving" : ""]
              .filter(Boolean)
              .join(" ")}
            aria-hidden={!printing && !isActive}
          >
            {slide.content}
          </section>
        );
      })}

      <div className="deck-chrome">
        <div className="deck-progress" style={{ width: `${((active + 1) / total) * 100}%` }} />
        <div className="deck-pagecount">
          <span>{String(active + 1).padStart(2, "0")}</span>
          <span> / {String(total).padStart(2, "0")}</span>
        </div>
        <div className="deck-nav">
          {downloadLabel ? (
            <button
              type="button"
              className="deck-nav-btn deck-nav-btn--wide"
              onClick={download}
              aria-label={downloadLabel}
            >
              {downloadLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="deck-nav-btn"
            onClick={() => goTo(active - 1)}
            disabled={active === 0}
            aria-label="Previous slide"
          >
            &larr;
          </button>
          <button
            type="button"
            className="deck-nav-btn"
            onClick={() => goTo(active + 1)}
            disabled={active === total - 1}
            aria-label="Next slide"
          >
            &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
