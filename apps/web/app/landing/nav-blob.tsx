"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { BLOB, BLOB_CLOSED_PATH, BLOB_OPEN_PATH } from "./blob-paths";
import { isInternal, type NavLink } from "./nav-links";
import { useReduced } from "./scenes";

/** Spec values (§4.1a): the shape and its path spring together. */
const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const INSTANT = { duration: 0 } as const;
/** Spec easing for the flip (§4.1b). */
const FLIP_EASE = [0.4, 0, 0.2, 1] as const;

type NavigateHandler = (link: NavLink, e: React.MouseEvent<HTMLAnchorElement>) => void;

/**
 * One menu row: a rolling sign. The uppercase label rotates away backward
 * on X (pivoting on its bottom edge) while an italic serif description
 * rotates down into place (pivoting on its top edge).
 *
 * The reference only flips on hover, which hides the description from
 * keyboard users entirely. Here focus drives the same state as hover, so a
 * link reads the same whichever way it was reached. Under reduced motion
 * the rotation is dropped and the two simply cross-fade.
 */
function FlipLink({
  link,
  active,
  reduced,
  onNavigate,
}: {
  link: NavLink;
  active: boolean;
  reduced: boolean;
  onNavigate: NavigateHandler;
}) {
  const [flipped, setFlipped] = useState(false);
  const t = reduced ? INSTANT : { duration: 0.3, ease: FLIP_EASE };
  const Tag = isInternal(link.href) ? Link : "a";
  return (
    <Tag
      href={link.href}
      className={`lp-flip${active ? " is-active" : ""}`}
      aria-current={active ? "location" : undefined}
      // The one flag both hover and focus drive. Exposed so tests (and CSS)
      // can read it without reaching into motion's animated styles.
      data-flipped={flipped}
      onMouseEnter={() => setFlipped(true)}
      onMouseLeave={() => setFlipped(false)}
      onFocus={() => setFlipped(true)}
      onBlur={() => setFlipped(false)}
      onClick={(e: React.MouseEvent<HTMLAnchorElement>) => onNavigate(link, e)}
    >
      <span className="lp-flip-stage">
        <motion.span
          className="lp-flip-label"
          animate={{ rotateX: flipped && !reduced ? -90 : 0, opacity: flipped ? 0 : 1 }}
          transition={t}
        >
          {link.label}
        </motion.span>
        {/* Decorative: the link's accessible name is its label. */}
        <motion.span
          className="lp-flip-desc"
          aria-hidden="true"
          animate={{ rotateX: flipped || reduced ? 0 : 90, opacity: flipped ? 1 : 0 }}
          transition={t}
        >
          {link.desc}
        </motion.span>
      </span>
    </Tag>
  );
}

/**
 * The liquid "drip" menu (reference spec §4.1a): a drop of accent paint
 * hanging from the top edge of the viewport that springs open into a panel
 * of flip links, with the drip moving to the bottom centre.
 *
 * Shape and path animate together. The path can only be interpolated
 * because both strings share one command structure (see blob-paths.ts).
 *
 * Fixes the reference does not have: the toggle carries `aria-expanded`,
 * Escape closes the panel and returns focus to the toggle, and the shape
 * gets an ink outline so it stays visible when it hangs over an
 * accent-coloured section (the reference's yellow blob vanishes over its
 * own yellow docs section).
 */
export function BlobMenu({
  links,
  activeSection,
  onNavigate,
}: {
  links: readonly NavLink[];
  activeSection: string | null;
  onNavigate: NavigateHandler;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReduced();
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const spring = reduced ? INSTANT : SPRING;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleNavigate: NavigateHandler = (link, e) => {
    setOpen(false);
    onNavigate(link, e);
  };

  const size = open ? BLOB.open : BLOB.closed;

  return (
    <div className="lp-blob">
      <motion.div
        className="lp-blob-shape"
        initial={false}
        animate={{
          width: size.width,
          height: size.height,
          y: open ? 14 : 0,
          borderRadius: open ? "20px 20px 0 0" : "0px 0px 0 0",
        }}
        transition={spring}
      >
        <svg className="lp-blob-svg" width="100%" height="100%" fill="none" aria-hidden="true">
          <motion.path
            initial={false}
            animate={{ d: open ? BLOB_OPEN_PATH : BLOB_CLOSED_PATH }}
            transition={spring}
            fill="var(--lp-lime)"
            stroke="var(--lp-ink)"
            strokeWidth={2}
          />
        </svg>

        <button
          ref={toggle}
          type="button"
          className="lp-blob-toggle"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <AnimatePresence mode="wait" initial={false}>
            {open ? (
              <motion.span
                key="close"
                initial={{ rotate: -90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 90, opacity: 0 }}
                transition={reduced ? INSTANT : { duration: 0.2 }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 4l12 12M16 4L4 16" />
                </svg>
              </motion.span>
            ) : (
              <motion.span
                key="bars"
                initial={{ rotate: 90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: -90, opacity: 0 }}
                transition={reduced ? INSTANT : { duration: 0.2 }}
              >
                <svg width="22" height="14" viewBox="0 0 22 14" fill="currentColor">
                  <rect y="0" width="22" height="2.2" rx="1.1" />
                  <rect y="5.8" width="22" height="2.2" rx="1.1" />
                  <rect y="11.6" width="22" height="2.2" rx="1.1" />
                </svg>
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              id={panelId}
              className="lp-blob-links"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduced ? INSTANT : { delay: 0.1, duration: 0.2 }}
            >
              {links.map((l) => (
                <FlipLink
                  key={l.href}
                  link={l}
                  active={!!l.section && l.section === activeSection}
                  reduced={reduced}
                  onNavigate={handleNavigate}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Click-outside catcher. Pointer-only, so it is out of the tab order
          and the accessibility tree; keyboard users have Escape. */}
      {open && (
        <button
          type="button"
          className="lp-blob-scrim"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}
