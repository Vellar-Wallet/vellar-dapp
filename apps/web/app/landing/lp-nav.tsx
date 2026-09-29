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
 *  GitHub is rendered separately (below) so it can carry the star count. */
const DEV_LINKS = [
  { href: "https://docs.vellar.xyz/", label: "Docs" },
  { href: "https://playground.vellar.xyz/", label: "Playground" },
] as const;

/** Filled star, matching GitHub's own affordance so the count reads as a star
 *  count without needing a label. */
function StarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 .25l2.06 4.18 4.61.67-3.33 3.25.78 4.6L8 10.78l-4.12 2.17.78-4.6L1.33 5.1l4.61-.67z" />
    </svg>
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
    <div className="lp-nav-outer">
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
                <a href={GITHUB_URL} onClick={close} className="lp-nav-gh">
                  GitHub
                  {typeof stars === "number" && (
                    <span className="lp-nav-stars">
                      <StarIcon />
                      {formatStars(stars)}
                    </span>
                  )}
                </a>
              </div>
            </div>
          </div>
          <Link href="/about" className={path === "/about" ? "active" : ""} onClick={close}>
            About
          </Link>
        </div>
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
