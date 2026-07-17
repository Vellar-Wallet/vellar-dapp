import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { DocsNav } from "./docs-nav";

// Docs shell: brand topbar + left sidebar nav + content column, styled with the
// VELA design tokens (see the `.docs-*` rules in globals.css). The sidebar nav
// (active state + mobile toggle) is a client component; everything else is a
// server component.

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs-root">
      <header className="docs-topbar">
        <Link href="/" aria-label="VELA home" className="docs-brand">
          <Logo height={30} />
        </Link>
        <span className="docs-eyebrow mono">Developer docs</span>
        <div className="docs-topbar-spacer" />
        <Link href="/app" className="btn btn-signal btn-sm docs-launch">
          Launch app
        </Link>
      </header>

      <div className="docs-body">
        <DocsNav />
        <main className="docs-content">{children}</main>
      </div>
    </div>
  );
}
