"use client";

import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef, type ReactNode } from "react";

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
 * Reduced motion: every scene degrades to plain static content. The
 * wrapper collapses to auto height and the sticky/transform layer is
 * dropped entirely, so nothing pins, scales or blurs and the page reads
 * as an ordinary stack of sections.
 */

/**
 * The opening scene: pins for one viewport while shrinking, tilting and
 * dimming, as the next block's diagonal edge wipes across it.
 *
 * Spec values kept exactly (§4.2): scale 1→0.8, rotate 0→2deg,
 * opacity 1→0.1, all over the first 100vh of a 200vh wrapper.
 */
export function HeroScene({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  // offset start/start→end/start: progress 0 at the top of the wrapper,
  // 1 when its bottom reaches the viewport top. The wrapper is 200vh, so
  // the [0, 0.5] range below is exactly the first viewport of scrolling.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.8]);
  const rotate = useTransform(scrollYProgress, [0, 0.5], [0, 2]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0.1]);

  if (reduced) {
    return (
      <div className="lp-scene-outer lp-scene-outer--static">
        <section className="lp-hero-scene">{children}</section>
      </div>
    );
  }

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
 * Under reduced motion the overlap is removed — stacking a block over a
 * section that no longer animates would just hide content.
 */
export function Curtain({
  children,
  diagonal = false,
  tone = "ink",
  className = "",
}: {
  children: ReactNode;
  diagonal?: boolean;
  tone?: "ink" | "lime";
  className?: string;
}) {
  const reduced = useReducedMotion();
  const cls = [
    "lp-curtain",
    `lp-curtain--${tone}`,
    diagonal && !reduced && "lp-curtain--diagonal",
    !reduced && "lp-curtain--overlap",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={cls}>{children}</div>;
}

/**
 * A two-phase scrubbed scene: content advances through phase A, then the
 * whole scene recedes in phase B while the next curtain covers it.
 *
 * Phase A (progress 0→0.5) is handed to the child as `progress` so each
 * scene decides what "advancing" means. Phase B (0.5→1) is uniform:
 * scale 1→0.9, y 0→-40px, blur 0→4px, brightness 1→0.5, with the header
 * and body pulling apart (-150px / +150px) and fading out by 60%.
 *
 * Spec §4.6 values kept exactly. Blur is capped at the spec's 4px, which
 * is also the performance ceiling for a full-screen filter.
 */
export type ScrubRenderProps =
  | { reduced: true; read: null; exit: null }
  | { reduced: false; read: MotionValue<number>; exit: MotionValue<number> };

export function ScrubScene({
  children,
  height = "320vh",
  id,
}: {
  children: (p: ScrubRenderProps) => ReactNode;
  height?: string;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  // start/start→end/end: the full height of the wrapper scrolls through,
  // giving (height - 100vh) of actual scrubbing.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // Phase A drives the content; phase B drives the scene's exit.
  const read = useTransform(scrollYProgress, [0, 0.5], [0, 1]);
  const exit = useTransform(scrollYProgress, [0.5, 1], [0, 1]);
  const scale = useTransform(exit, [0, 1], [1, 0.9]);
  const y = useTransform(exit, [0, 1], ["0px", "-40px"]);
  const blur = useTransform(exit, [0, 1], [0, 4]);
  const bright = useTransform(exit, [0, 1], [1, 0.5]);
  const filter = useTransform([blur, bright], ([b, r]) => `blur(${b}px) brightness(${r})`);

  if (reduced) {
    return (
      <section id={id} className="lp-scrub lp-scrub--static">
        <div className="lp-scrub-inner">{children({ reduced: true, read: null, exit: null })}</div>
      </section>
    );
  }

  return (
    <section ref={ref} id={id} className="lp-scrub" style={{ height }}>
      <div className="lp-scene-sticky lp-scrub-sticky">
        <motion.div style={{ y, scale, filter }} className="lp-scrub-inner">
          {children({ reduced: false, read, exit })}
        </motion.div>
      </div>
    </section>
  );
}

/**
 * The paired exit transforms for a scrub scene's header and body: they
 * pull apart vertically and fade as the scene recedes (spec §4.6).
 *
 * Takes the scene's own `scrollYProgress` rather than a nullable value,
 * so this stays an ordinary unconditional hook. A scene running under
 * reduced motion simply does not call it.
 */
export function useScrubExit(exit: MotionValue<number>) {
  const headY = useTransform(exit, [0, 0.8], ["0px", "-150px"]);
  const headO = useTransform(exit, [0, 0.6], [1, 0]);
  const bodyY = useTransform(exit, [0, 0.8], ["0px", "150px"]);
  const bodyO = useTransform(exit, [0, 0.6], [1, 0]);
  return { headY, headO, bodyY, bodyO };
}
