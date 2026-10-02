"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { useReduced } from "./scenes";

/** One full period of the wave repeats every 720 units of a 2880-unit
 *  path, i.e. every quarter of the SVG. That is why the scroll translation
 *  below is exactly -25%: it moves the wave by one period, so the loop is
 *  seamless and no seam is ever visible. */
const WAVE_PATH =
  "M 0 200 L 0 100 C 120 50, 240 50, 360 100 S 600 150, 720 100 S 960 50, 1080 100 S 1320 150, 1440 100 S 1680 50, 1800 100 S 2040 150, 2160 100 S 2400 50, 2520 100 S 2760 150, 2880 100 L 2880 200 Z";

/**
 * The wavy top edge a curtain wears while it rises (reference spec §4.7).
 *
 * Placed as the first child of a positioned section, it hangs above the
 * section's top edge and "surfs": as the section scrolls from the bottom
 * of the viewport to its top, the wave drifts one full period sideways.
 *
 * Mechanics kept from the spec: the SVG is 400% wide with
 * `preserveAspectRatio="none"`, the translate is -25% (one period), and
 * the wrapper sits at `-translate-y-[99%]` rather than 100% so a hairline
 * of subpixel rounding never opens a gap between wave and section.
 *
 * Fill is `currentColor`, so the wave always matches whatever ground the
 * parent sets, with no colour repeated here.
 *
 * Under reduced motion the wave is drawn once and does not move.
 */
export function WaveEdge() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReduced();
  // Progress runs while the *wrapper's* top travels from the viewport's
  // bottom edge to its top edge, which is the stretch where the wave is
  // actually on screen.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "start start"] });
  const x = useTransform(scrollYProgress, [0, 1], ["0%", "-25%"]);

  return (
    <div ref={ref} className="lp-wave" aria-hidden="true">
      <motion.svg
        style={reduced ? undefined : { x }}
        viewBox="0 0 2880 200"
        preserveAspectRatio="none"
        className="lp-wave-svg"
      >
        <path fill="currentColor" d={WAVE_PATH} />
      </motion.svg>
    </div>
  );
}
