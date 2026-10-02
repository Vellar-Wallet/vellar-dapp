"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef, type ReactNode } from "react";
import { useMediaQuery } from "./use-media";

/**
 * Sticky-scene and curtain primitives — the page's layering architecture.
 *
 * The structure (reference spec §3.2) is a stack of sticky "scenes" and
 * "curtains": a scene pins for the height of its tall outer wrapper while
 * its contents animate, then the next block slides up over it with a
 * negative top margin and a higher z-index, covering the scene's last
 * viewport so its exit plays underneath.
 *
 * Three rules make it work, and all three are easy to break:
 *  1. `useScroll` must target the TALL OUTER wrapper, never the sticky
 *     child — a sticky element's own scroll progress is meaningless.
 *  2. No ancestor of a sticky element may have `overflow: hidden`, or
 *     the stickiness silently dies. Horizontal clipping uses
 *     `overflow-x: clip` instead, which does not create a scroll
 *     container.
 *  3. The page ground must be the dark ink, because a scene that scales
 *     down reveals whatever is behind it — that reveal is the effect.
 *
 * Reduced motion has two layers, on purpose. CSS (`landing.css`) removes
 * the pin, the overlap and the clip under the media query, so a
 * reduced-motion visitor never even sees the pinned layout. This file
 * additionally stops the scroll-linked transforms by rendering a separate
 * static component, so no scroll hook ever runs, and none can point at a
 * ref that was never mounted.
 *
 * The motion/static choice is made with `useMediaQuery` (use-media.ts), a
 * `useSyncExternalStore` hook whose server snapshot is `false`. That is what keeps hydration honest: the
 * server and the first client render always agree (animated tree), then
 * the client updates. motion's own `useReducedMotion` reads the preference
 * on the first client render, which differs from the server and makes
 * React discard and rebuild the tree.
 */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const SHORT_QUERY = "(max-height: 520px)";

/** True when the visitor prefers reduced motion. Hydration-safe. */
export function useReduced() {
  return useMediaQuery(REDUCED_QUERY);
}

/**
 * The opening scene: pins for one viewport while shrinking, tilting and
 * dimming, as the next block's diagonal edge wipes across it.
 *
 * Spec values kept exactly (§4.2): scale 1→0.8, rotate 0→2deg,
 * opacity 1→0.1, all over the first 100vh of a 200vh wrapper.
 */
export function HeroScene({ children }: { children: ReactNode }) {
  const reduced = useReduced();
  // A phone held sideways is ~375px tall: too short to pin a one-screen hero
  // without cutting its content off, so it gets the same plain, scrolling
  // layout as reduced motion (landing.css states the same rule for first
  // paint).
  const short = useMediaQuery(SHORT_QUERY);
  if (reduced || short) {
    return (
      <div className="lp-scene-outer lp-scene-outer--hero">
        <section className="lp-hero-scene">{children}</section>
      </div>
    );
  }
  return <LiveHeroScene>{children}</LiveHeroScene>;
}

function LiveHeroScene({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // offset start/start→end/start: progress 0 at the top of the wrapper,
  // 1 when its bottom reaches the viewport top. The wrapper is 200vh, so
  // the [0, 0.5] range below is exactly the first viewport of scrolling.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.8]);
  const rotate = useTransform(scrollYProgress, [0, 0.5], [0, 2]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0.1]);

  return (
    <div ref={ref} className="lp-scene-outer lp-scene-outer--hero">
      <motion.section style={{ scale, rotate, opacity }} className="lp-hero-scene lp-scene-sticky">
        {children}
      </motion.section>
    </div>
  );
}

/**
 * A curtain: the block that rises over the scene before it.
 *
 * `-mt-[100vh]` pulls it up over the previous scene's final viewport and
 * the raised z-index puts it on top, so the scene exits *behind* it. The
 * diagonal variant adds the slanted top edge (spec §4.4) which the
 * shrinking hero passes under.
 *
 * It is pure layout, so its class list does not depend on the reduced
 * motion preference at all: the media query in landing.css removes the
 * overlap and the clip. That keeps it identical on server and client.
 */
export function Curtain({
  children,
  diagonal = false,
  overlap = true,
  tone = "ink",
  className = "",
}: {
  children: ReactNode;
  diagonal?: boolean;
  /** Pull up over the previous scene's last viewport. Only meaningful
   *  when the block before is a sticky scene; otherwise leave it off. */
  overlap?: boolean;
  tone?: "ink" | "paper" | "tint" | "lime";
  className?: string;
}) {
  const cls = [
    "lp-curtain",
    `lp-curtain--${tone}`,
    diagonal && "lp-curtain--diagonal",
    overlap && "lp-curtain--overlap",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={cls}>{children}</div>;
}
