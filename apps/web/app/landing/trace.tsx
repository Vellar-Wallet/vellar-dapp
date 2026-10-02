"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { Eyebrow } from "./ui";
import { ScrubScene, useScrubExit } from "./scenes";

const ROWS = [
  { label: "GET /v1/research", value: "402", tone: "bad" },
  { label: "price", value: "0.05 USDC" },
  { label: "/verify", value: "✓ valid", tone: "ok" },
  { label: "/settle", value: "✓ fee sponsored", tone: "ok" },
  { label: "resource", value: "200 OK", tone: "ok" },
] as const;

/** One request row. It stays dim until the request reaches it, then
 *  lights and slides into place. The five rows share phase A evenly, so
 *  row `i` owns the slice [i/N, (i+1)/N] of the read progress. */
function TraceRow({
  row,
  index,
  read,
  live,
}: {
  row: (typeof ROWS)[number];
  index: number;
  read: MotionValue<number>;
  live: boolean;
}) {
  const from = index / ROWS.length;
  const to = (index + 1) / ROWS.length;
  const lit = useTransform(read, [from, to], [0.22, 1]);
  const x = useTransform(read, [from, to], [-10, 0]);
  const tone = "tone" in row ? row.tone : undefined;
  return (
    <motion.div
      className="lp-trace-row"
      style={live ? { opacity: lit, x } : undefined}
    >
      <span>{row.label}</span>
      <b className={tone}>{row.value}</b>
    </motion.div>
  );
}

/** The pinned 402 → 200 moment, as a two-phase scrubbed scene (reference
 *  spec §4.6): the request advances row by row while pinned, then the
 *  scene recedes and the header and panel pull apart as the next block
 *  rises over it. Below 800px, and under reduced motion, it is a plain
 *  static section showing the finished trace. */
export function TraceSection() {
  return (
    <ScrubScene id="trace" className="lp-trace">
      {(scene) => <TraceBody read={scene.read} exit={scene.exit} live={!scene.reduced} />}
    </ScrubScene>
  );
}

function TraceBody({
  read,
  exit,
  live,
}: {
  read: MotionValue<number>;
  exit: MotionValue<number>;
  /** False when the scene is static: values are not applied as styles. */
  live: boolean;
}) {
  const motionExit = useScrubExit(exit);
  const barScale = useTransform(read, [0, 1], [0, 1]);

  return (
    <div className="lp-wrap lp-trace-pin">
      <div className="lp-trace-grid">
        <motion.div style={live ? { y: motionExit.headY, opacity: motionExit.headO } : undefined}>
          <Eyebrow>One request, end to end</Eyebrow>
          <h2 className="mt-[var(--lp-sp-4)]!">
            An agent hits a paywall. <em>Vellar settles it.</em>
          </h2>
          <p className="lp-lead">
            The resource server returns 402 with a payment challenge. The agent signs a payment
            authorization and retries. Vellar verifies the signature, settles the transaction on
            Stellar, and sponsors the network fee, then the resource server returns 200.
          </p>
        </motion.div>
        <motion.div
          className="lp-trace-panel"
          style={live ? { y: motionExit.bodyY, opacity: motionExit.bodyO } : undefined}
        >
          <div className="head">
            <span>buyer → seller · x402</span>
            <span>402 → 200</span>
          </div>
          {ROWS.map((r, i) => (
            <TraceRow key={r.label} row={r} index={i} read={read} live={live} />
          ))}
          <div className="lp-trace-bar">
            <motion.i style={live ? { scaleX: barScale, transformOrigin: "left center" } : undefined} />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
