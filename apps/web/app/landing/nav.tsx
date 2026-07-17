"use client";

import Link from "next/link";
import { useState } from "react";

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="nav-outer">
      <nav className="nav">
        <a href="#top" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-light.png" alt="Vellar" />
        </a>
        <div className={`nav-links${open ? " open" : ""}`}>
          <Link href="/about" onClick={close}>
            About
          </Link>
          <a href="#faq" onClick={close}>
            FAQ
          </a>
          <a href="https://docs.vellar.xyz/" onClick={close}>
            Docs
          </a>
        </div>
        <Link href="/app" className="btn btn-signal">
          Launch app
        </Link>
        <button className="nav-toggle" onClick={() => setOpen(!open)} aria-label="Menu">
          ☰
        </button>
      </nav>
    </div>
  );
}
