"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { scrollToSection, useScrollSpy } from "./use-scroll-spy";
import { formatStars } from "./github-stars";
import { BlobMenu } from "./nav-blob";
import { MenuToggle, MobileMenu } from "./nav-mobile";
import { GITHUB_URL, NAV_LINKS, NAV_SECTION_IDS, type NavLink } from "./nav-links";
import { useMediaQuery } from "./use-media";
import { lockScroll } from "./scroll-lock";

/** Filled star, matching GitHub's own affordance so the count reads as a star
 *  count without needing a label. */
function StarIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className="lp-star-ico"
    >
      <path d="M8 .25l2.06 4.18 4.61.67-3.33 3.25.78 4.6L8 10.78l-4.12 2.17.78-4.6L1.33 5.1l4.61-.67z" />
    </svg>
  );
}

/** GitHub's own mark — without it the button reads as a generic "star this",
 *  with it the destination is obvious before the click. */
function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Top-level GitHub star button. Renders as a plain link when the count is
 *  unknown, so a GitHub outage degrades to a normal link rather than a
 *  half-empty button. */
function StarButton({ stars }: { stars?: number | null }) {
  const has = typeof stars === "number";
  return (
    <a
      href={GITHUB_URL}
      className="lp-star-btn"
      target="_blank"
      rel="noreferrer"
      aria-label={has ? `Star vellar-facilitator on GitHub — ${stars} stars` : "Vellar on GitHub"}
    >
      <span className="lp-star-btn-face">
        <GitHubIcon />
        <span className="lp-star-btn-label">Star</span>
      </span>
      {has && (
        <span className="lp-star-btn-count">
          <StarIcon />
          {formatStars(stars)}
        </span>
      )}
    </a>
  );
}

/** Nav for all .lp marketing pages.
 *
 *  Desktop: the logo, the star button and the docs CTA sit on the bar; every
 *  other link lives in the liquid drip menu hanging from the top edge
 *  (nav-blob.tsx). Below 820px that menu is replaced by a full-screen sheet
 *  behind a hamburger (nav-mobile.tsx). Both read the same NAV_LINKS, so
 *  they cannot drift apart.
 *
 *  `stars` is passed in from LpShell (a server component) rather than fetched
 *  here: this is a client component, and a per-visitor GitHub call would hit
 *  the unauthenticated 60/hour-per-IP limit. `null` means "unknown" — the
 *  badge is omitted entirely rather than rendering a misleading zero. */
export function LpNav({ stars }: { stars?: number | null }) {
  // `open` is the MOBILE sheet; the desktop drip keeps its own state.
  const [open, setOpen] = useState(false);
  // The nav floats transparent over the hero and takes a paper backdrop
  // once the page has moved. Threshold is small on purpose: the hero scene
  // starts shrinking immediately, so the bar must be readable by then.
  const [scrolled, setScrolled] = useState(false);
  const toggle = useRef<HTMLButtonElement | null>(null);
  // usePathname (not window.location read once on mount): the nav lives in the
  // shared layout, so client-side navigation must re-derive the active link.
  const path = usePathname() ?? "";
  const onLanding = path === "/";
  const section = useScrollSpy(NAV_SECTION_IDS, onLanding);
  const activeSection = onLanding ? section : null;
  const wide = useMediaQuery("(min-width: 821px)");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Pause page scrolling behind the open sheet, and always give it back.
  useEffect(() => {
    if (!open) return;
    lockScroll(true);
    return () => lockScroll(false);
  }, [open]);

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

  // A sheet left open across a resize to desktop, or across a navigation,
  // would strand the scroll lock with nothing visible to dismiss it.
  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);
  useEffect(() => {
    setOpen(false);
  }, [path]);

  const navigate = (link: NavLink, e: React.MouseEvent<HTMLAnchorElement>) => {
    setOpen(false);
    if (!link.section || !onLanding) return;
    e.preventDefault();
    scrollToSection(link.section);
  };

  return (
    <>
      <div className={`lp-nav-outer${scrolled || open ? " is-scrolled" : ""}`}>
        <nav className="lp-nav" aria-label="Primary">
          <Link href="/" className="lp-brand" onClick={() => setOpen(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="Vellar" />
          </Link>
          <BlobMenu links={NAV_LINKS} activeSection={activeSection} onNavigate={navigate} />
          <StarButton stars={stars} />
          <a href="https://docs.vellar.xyz/" className="lp-btn lp-btn--forest">
            Read the docs
          </a>
          <MenuToggle buttonRef={toggle} open={open} onToggle={() => setOpen(!open)} />
        </nav>
      </div>
      {/* A sibling of the bar, not a child. The scrolled bar carries a
          backdrop-filter, and a backdrop-filter makes its element the
          containing block for `position: fixed` descendants, which would
          shrink this "full-screen" sheet to the height of the bar. */}
      <MobileMenu
        open={open}
        links={NAV_LINKS}
        activeSection={activeSection}
        onNavigate={navigate}
      />
    </>
  );
}
