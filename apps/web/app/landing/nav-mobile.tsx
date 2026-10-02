"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { isInternal, type NavLink } from "./nav-links";
import { LpButton } from "./ui";
import { useReduced } from "./scenes";

/** Spec values (§4.1c): a strong in-out curve for the wipe, an
 *  ease-out-quart-ish one for the links. */
const WIPE_EASE = [0.76, 0, 0.24, 1] as const;
const LINK_EASE = [0.25, 1, 0.5, 1] as const;
const INSTANT = { duration: 0 } as const;

export const MOBILE_MENU_ID = "lp-mobile-menu";

/**
 * The hamburger that morphs into an X (reference spec §4.1c): three lines;
 * on open the top and bottom rotate to +/-45deg and meet in the middle
 * while the centre line fades. motion's default spring, as in the spec.
 *
 * `aria-expanded` and `aria-controls` are the reference's missing piece.
 */
export function MenuToggle({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  /** Lets the caller return focus here when Escape closes the sheet. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const reduced = useReduced();
  const t = reduced ? INSTANT : undefined;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="lp-nav-toggle"
      aria-label="Menu"
      aria-expanded={open}
      aria-controls={MOBILE_MENU_ID}
      onClick={onToggle}
    >
      <span className="lp-burger" aria-hidden="true">
        <motion.i animate={open ? { rotate: 45, y: 6 } : { rotate: 0, y: 0 }} transition={t} />
        <motion.i animate={{ opacity: open ? 0 : 1 }} transition={t} />
        <motion.i animate={open ? { rotate: -45, y: -6 } : { rotate: 0, y: 0 }} transition={t} />
      </span>
    </button>
  );
}

/**
 * The full-screen accent sheet that wipes down from the top edge, with the
 * links sliding in one after another and the calls to action pinned below.
 *
 * It sits under the nav bar (which stays on top, so the logo and the
 * toggle are always reachable) and locks page scroll while open; the
 * caller does the locking so this stays presentational. Every motion is
 * dropped under reduced motion: the sheet and its links simply appear.
 */
export function MobileMenu({
  open,
  links,
  activeSection,
  onNavigate,
}: {
  open: boolean;
  links: readonly NavLink[];
  activeSection: string | null;
  onNavigate: (link: NavLink, e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const reduced = useReduced();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id={MOBILE_MENU_ID}
          className="lp-mmenu"
          // The sheet scrolls itself on short screens; tell the smooth-scroll
          // runtime to leave its wheel and touch handling alone.
          data-lenis-prevent
          initial={{ clipPath: "inset(0 0 100% 0)" }}
          animate={{ clipPath: "inset(0 0 0% 0)" }}
          exit={{ clipPath: "inset(0 0 100% 0)" }}
          transition={reduced ? INSTANT : { duration: 0.45, ease: WIPE_EASE }}
        >
          <ul className="lp-mmenu-list">
            {links.map((l, i) => {
              const Tag = isInternal(l.href) ? Link : "a";
              const active = !!l.section && l.section === activeSection;
              return (
                <motion.li
                  key={l.href}
                  initial={{ x: -40, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 40, opacity: 0 }}
                  transition={
                    reduced ? INSTANT : { delay: 0.15 + 0.08 * i, duration: 0.5, ease: LINK_EASE }
                  }
                >
                  <Tag
                    href={l.href}
                    className={`lp-mmenu-link${active ? " is-active" : ""}`}
                    aria-current={active ? "location" : undefined}
                    onClick={(e: React.MouseEvent<HTMLAnchorElement>) => onNavigate(l, e)}
                  >
                    <span className="lp-mmenu-label">{l.label}</span>
                    <span className="lp-mmenu-desc">{l.desc}</span>
                  </Tag>
                </motion.li>
              );
            })}
          </ul>

          <motion.div
            className="lp-mmenu-cta"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? INSTANT : { delay: 0.35, duration: 0.4 }}
          >
            <LpButton
              href="https://docs.vellar.xyz/docs/getting-started/quickstart"
              variant="forest"
              size="lg"
            >
              Quickstart
            </LpButton>
            <LpButton
              href="https://github.com/Vellar-Wallet/vellar-facilitator"
              variant="outline"
              size="lg"
            >
              Facilitator on GitHub
            </LpButton>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
