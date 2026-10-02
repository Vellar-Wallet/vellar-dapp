"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { scrollToSection, useScrollSpy } from "./use-scroll-spy";
import { formatStars, STARS_REPO } from "./github-stars";

/** Landing sections the nav tracks for scroll-spy highlighting. */
const SECTIONS = [
  { id: "how", label: "How it works" },
  { id: "bazaar", label: "Bazaar" },
] as const;

const SECTION_IDS = SECTIONS.map((s) => s.id);

const GITHUB_URL = `https://github.com/${STARS_REPO}`;

/** Developer surfaces, grouped under one dropdown so the bar stays short.
 *  GitHub also gets its own top-level nav button (below) carrying the star
 *  count — social proof buried in a hover menu is social proof nobody sees. */
const DEV_LINKS = [
  { href: "https://docs.vellar.xyz/", label: "Docs" },
  { href: "https://playground.vellar.xyz/", label: "Playground" },
  { href: GITHUB_URL, label: "GitHub" },
] as const;

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

/** Sticky paper nav for all .lp marketing pages.
 *
 *  `stars` is passed in from LpShell (a server component) rather than fetched
 *  here: this is a client component, and a per-visitor GitHub call would hit
 *  the unauthenticated 60/hour-per-IP limit. `null` means "unknown" — the
 *  badge is omitted entirely rather than rendering a misleading zero. */
export function LpNav({ stars }: { stars?: number | null }) {
  const [open, setOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  // The nav floats transparent over the hero and takes a paper backdrop
  // once the page has moved. Threshold is small on purpose: the hero scene
  // starts shrinking immediately, so the bar must be readable by then.
  const [scrolled, setScrolled] = useState(false);
  const close = () => {
    setOpen(false);
    setDevOpen(false);
  };
  // usePathname (not window.location read once on mount): the nav lives in the
  // shared layout, so client-side navigation must re-derive the active link.
  const path = usePathname() ?? "";
  const onLanding = path === "/";
  const section = useScrollSpy(SECTION_IDS, onLanding);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!devOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDevOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [devOpen]);

  const goTo = (id: string) => (e: React.MouseEvent) => {
    close();
    if (!onLanding) return;
    e.preventDefault();
    scrollToSection(id);
  };

  return (
    <div className={`lp-nav-outer${scrolled || open ? " is-scrolled" : ""}`}>
      <nav className="lp-nav">
        <Link href="/" className="lp-brand" onClick={close}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Vellar" />
        </Link>
        <div className={`lp-nav-links${open ? " open" : ""}`}>
          {SECTIONS.map((s) => (
            <Link
              key={s.id}
              href={`/#${s.id}`}
              className={onLanding && section === s.id ? "active" : ""}
              onClick={goTo(s.id)}
            >
              {s.label}
            </Link>
          ))}
          <div
            className={`lp-nav-dd${devOpen ? " open" : ""}`}
            onMouseEnter={() => setDevOpen(true)}
            onMouseLeave={() => setDevOpen(false)}
          >
            <button
              type="button"
              className="lp-nav-dd-btn"
              aria-haspopup="true"
              aria-expanded={devOpen}
              onClick={() => setDevOpen(!devOpen)}
            >
              Developers
              <svg
                width="10"
                height="6"
                viewBox="0 0 10 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M1 1l4 4 4-4" />
              </svg>
            </button>
            <div className="lp-nav-dd-panel">
              <div className="lp-nav-dd-card">
                {DEV_LINKS.map((l) => (
                  <a key={l.href} href={l.href} onClick={close}>
                    {l.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
          <Link href="/about" className={path === "/about" ? "active" : ""} onClick={close}>
            About
          </Link>
        </div>
        <StarButton stars={stars} />
        <a href="https://docs.vellar.xyz/" className="lp-btn lp-btn--forest">
          Read the docs
        </a>
        <button
          className="lp-nav-toggle"
          onClick={() => setOpen(!open)}
          aria-label="Menu"
          aria-expanded={open}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            {open ? <path d="M4 4l14 14M18 4L4 18" /> : <path d="M3 6h16M3 11h16M3 16h16" />}
          </svg>
        </button>
      </nav>
    </div>
  );
}
