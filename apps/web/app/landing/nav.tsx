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
          <a href="#features" onClick={close}>
            Features
          </a>
          <a href="#wallet" onClick={close}>
            Wallet
          </a>
          <a href="#platforms" onClick={close}>
            Extension
          </a>
          <a href="#faq" onClick={close}>
            FAQ
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
