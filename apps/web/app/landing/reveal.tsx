"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

/**
 * Fade-up on enter, driven by an IntersectionObserver and plain CSS
 * transitions rather than a scroll library (reference spec §3.3).
 *
 * Spec values kept: 0.6s ease, 30px rise, fires once at 10% visibility,
 * staggered by passing increasing `delay`s.
 *
 * Two deliberate departures from the spec's version:
 *
 *  - The initial hidden state lives in CSS (`.lp-reveal`), not in an
 *    inline style, so `prefers-reduced-motion` can force it visible.
 *    The spec's version hard-codes `opacity: 0` inline, which means
 *    anything it wraps is invisible to a reduced-motion user until it
 *    happens to scroll into view. The spec itself flags this as an edge
 *    case; here it is simply fixed.
 *  - If the observer never fires (no IO support), the element is shown
 *    rather than left hidden. Failing open matters more than the
 *    animation.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
  duration = 0.6,
  y = 30,
  threshold = 0.1,
  as: Tag = "div" as ElementType,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  y?: number;
  threshold?: number;
  as?: ElementType;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return (
    <Tag
      ref={ref}
      className={`lp-reveal${shown ? " is-in" : ""}${className ? ` ${className}` : ""}`}
      style={{
        transitionDuration: `${duration}s`,
        transitionDelay: `${delay}s`,
        // Only the distance is inline; the hidden state itself is CSS so
        // the reduced-motion override can win.
        "--lp-reveal-y": `${y}px`,
        transform: shown ? undefined : `translateY(${y}px)`,
      } as React.CSSProperties}
      {...rest}
    >
      {children}
    </Tag>
  );
}
