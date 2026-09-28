"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { scrollToSection, useScrollSpy } from "./use-scroll-spy";

/** Landing sections the nav tracks for scroll-spy highlighting. */
const SECTIONS = [
  { id: "how", label: "How it works" },
  { id: "bazaar", label: "Bazaar" },
] as const;

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Developer surfaces, grouped under one dropdown so the bar stays short. */
const DEV_LINKS = [
  { href: "https://docs.vellar.xyz/", label: "Docs" },
  { href: "https://playground.vellar.xyz/", label: "Playground" },
  { href: "https://github.com/Vellar-Wallet/vellar-facilitator", label: "GitHub" },
] as const;

/** Sticky paper nav for all .lp marketing pages. */
export function LpNav() {
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
