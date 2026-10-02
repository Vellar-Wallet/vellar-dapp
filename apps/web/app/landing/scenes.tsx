"use client";

import { motion, useMotionValue, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";

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
 * The motion/static choice is made with `useSyncExternalStore` and a
 * server snapshot of `false`. That is what keeps hydration honest: the
 * server and the first client render always agree (animated tree), then
 * the client updates. motion's own `useReducedMotion` reads the preference
 * on the first client render, which differs from the server and makes
 * React discard and rebuild the tree.
 */

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** Below this width a scrubbed scene does not pin: its content (a header
 *  stacked over a panel) is taller than a phone viewport, and pinning
 *  content taller than the screen clips it. Matches the breakpoint the
 *  previous GSAP trace used, so small-screen behaviour is unchanged. */
const NARROW_QUERY = "(max-width: 800px)";

/** True when the visitor prefers reduced motion. Hydration-safe. */
export function useReduced() {
  return useMediaQuery(REDUCED_QUERY);
}

/** True when the viewport is too narrow to pin a scrubbed scene. */
export function useNarrow() {
  return useMediaQuery(NARROW_QUERY);
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
  if (reduced) {
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
  tone?: "ink" | "lime";
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

/** What a scrub scene hands its children. Always real motion values: in a
 *  static scene (reduced motion, or too narrow to pin) they are pinned to
 *  the finished state (`read` 1, `exit` 0), so children never branch on
 *  whether hooks may run and nothing has to be faked. `reduced` tells a
 *  child whether to skip applying them as styles at all. */
export type ScrubRenderProps = {
  reduced: boolean;
  read: MotionValue<number>;
  exit: MotionValue<number>;
};

type ScrubSceneProps = {
  children: (p: ScrubRenderProps) => ReactNode;
  height?: string;
  id?: string;
  className?: string;
};

/**
 * A two-phase scrubbed scene: content advances through phase A, then the
 * whole scene recedes in phase B while the next curtain covers it.
 *
 * Phase A (progress 0→0.5) is handed to the child as `read` so each scene
 * decides what "advancing" means. Phase B (0.5→1) is uniform:
 * scale 1→0.9, y 0→-40px, blur 0→4px, brightness 1→0.5, with the header
 * and body pulling apart (-150px / +150px) and fading out by 60%.
 *
 * Spec §4.6 values kept exactly. Blur is capped at the spec's 4px, which
 * is also the performance ceiling for a full-screen filter.
 */
export function ScrubScene(props: ScrubSceneProps) {
  const reduced = useReduced();
  const narrow = useNarrow();
  return reduced || narrow ? <StaticScrubScene {...props} /> : <LiveScrubScene {...props} />;
}

function StaticScrubScene({ children, id, className = "" }: ScrubSceneProps) {
  // Finished-state values (see ScrubRenderProps).
  const read = useMotionValue(1);
  const exit = useMotionValue(0);
  return (
    <section id={id} className={`lp-scrub lp-scrub--static ${className}`.trim()}>
      <div className="lp-scrub-inner">{children({ reduced: true, read, exit })}</div>
    </section>
  );
}

function LiveScrubScene({ children, height = "320vh", id, className = "" }: ScrubSceneProps) {
  const ref = useRef<HTMLElement>(null);
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

  return (
    <section ref={ref} id={id} className={`lp-scrub ${className}`.trim()} style={{ height }}>
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
 * Takes the scene's `exit` progress, so this stays an ordinary
 * unconditional hook. A static scene hands it the finished-state value.
 */
export function useScrubExit(exit: MotionValue<number>) {
  const headY = useTransform(exit, [0, 0.8], ["0px", "-150px"]);
  const headO = useTransform(exit, [0, 0.6], [1, 0]);
  const bodyY = useTransform(exit, [0, 0.8], ["0px", "150px"]);
  const bodyO = useTransform(exit, [0, 0.6], [1, 0]);
  return { headY, headO, bodyY, bodyO };
}
