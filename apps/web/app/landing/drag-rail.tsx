"use client";

import { motion, useMotionValue, useSpring } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useReduced } from "./scenes";
import { useMediaQuery } from "./use-media";

/** Spring that trails the pointer. Spec value (§4.7): damping 25,
 *  stiffness 300, mass 0.5, a quick, slightly soft follow. */
const CURSOR_SPRING = { damping: 25, stiffness: 300, mass: 0.5 } as const;

/** A real mouse, not a touchscreen or a pen. The "drag" cursor only means
 *  something to a pointer you can hover with. */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/**
 * A horizontally scrolling rail with mouse drag and a spring-following
 * "drag" cursor (reference spec §4.7).
 *
 * The spec builds this on motion's `drag="x"`, which takes over touch and
 * replaces native scrolling. That is the wrong trade here, because the
 * rail has to stay usable by keyboard and touch. So the scroller is a
 * plain `overflow-x: auto` element and the browser does the real work:
 *
 *  - touch and trackpad: native momentum scrolling, with scroll-snap
 *  - keyboard: the track is focusable, so arrow keys / Home / End scroll
 *    it, and prev/next buttons give a visible alternative
 *  - mouse: pointer events translate a drag into `scrollLeft`
 *
 * Only a mouse gets the drag handlers and the cursor. Under reduced
 * motion the cursor is not rendered and button scrolls are instant.
 */
export function DragRail({ children, label }: { children: ReactNode; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startLeft: number } | null>(null);
  const reduced = useReduced();
  const fine = useMediaQuery(FINE_POINTER);

  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: false });

  const mx = useMotionValue(-100);
  const my = useMotionValue(-100);
  const sx = useSpring(mx, CURSOR_SPRING);
  const sy = useSpring(my, CURSOR_SPRING);

  // Which way can the rail still go? Drives the buttons' disabled state.
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // Follow the pointer only while it is over the rail.
  useEffect(() => {
    if (!hovering || !fine || reduced) return;
    const move = (e: MouseEvent) => {
      mx.set(e.clientX);
      my.set(e.clientY);
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, [hovering, fine, reduced, mx, my]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduced ? "auto" : "smooth" });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = track.current;
    if (!el || e.pointerType !== "mouse" || e.button !== 0) return;
    drag.current = { startX: e.clientX, startLeft: el.scrollLeft };
    setDragging(true);
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = track.current;
    if (!el || !drag.current) return;
    el.scrollLeft = drag.current.startLeft - (e.clientX - drag.current.startX);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const showCursor = hovering && fine && !reduced;

  return (
    <div
      className="lp-rail"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {fine && !reduced && (
        <motion.div
          aria-hidden="true"
          className="lp-rail-cursor"
          style={{ x: sx, y: sy, translateX: "-50%", translateY: "-50%" }}
          animate={{ opacity: showCursor ? 1 : 0, scale: showCursor ? (dragging ? 0.9 : 1) : 0 }}
        >
          <span aria-hidden="true">◀</span> Drag <span aria-hidden="true">▶</span>
        </motion.div>
      )}

      <div
        ref={track}
        className={`lp-rail-track${dragging ? " is-dragging" : ""}`}
        // A scroll container with no focusable children is unreachable by
        // keyboard; tabIndex makes the arrow keys work on it.
        tabIndex={0}
        role="region"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {children}
      </div>

      <div className="lp-rail-nav">
        <button
          type="button"
          className="lp-rail-btn"
          aria-label="Previous"
          disabled={edges.start}
          onClick={() => scrollByPage(-1)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M11 3L5 9l6 6" />
          </svg>
        </button>
        <button
          type="button"
          className="lp-rail-btn"
          aria-label="Next"
          disabled={edges.end}
          onClick={() => scrollByPage(1)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M7 3l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
