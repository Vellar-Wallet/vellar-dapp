"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DOC_PAGES } from "@/lib/docs-registry";

// Client-side docs nav: active-link highlighting + a mobile open/close toggle
// (the sidebar is off-canvas below the docs breakpoint).

export function DocsNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="docs-menu-btn neo-btn"
        aria-label="Toggle documentation menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Menu"}
      </button>

      <aside className={`docs-sidebar${open ? " open" : ""}`}>
        <nav>
          <p className="docs-nav-label mono">Documentation</p>
          {DOC_PAGES.map((p) => {
            const href = `/docs/${p.slug}`;
            const active = pathname === href;
            return (
              <Link
                key={p.slug}
                href={href}
                className={`docs-nav-link${active ? " active" : ""}`}
                onClick={() => setOpen(false)}
              >
                {p.nav}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
