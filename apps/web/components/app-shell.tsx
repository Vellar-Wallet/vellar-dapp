"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useTheme } from "@/lib/theme";
import { useWalletActions, useWalletSession, useWalletStatus } from "@/lib/wallet-context";
import { Logo } from "./logo";

// App shell (docs/decisions.md dark-neomorphic dashboard): fixed left icon
// sidebar + top bar (address, network, Send/Receive) around a panel-grid
// content area. Guards the session and redirects to /app when signed out.

const nav = [
  { href: "/dashboard", label: "Wallet", icon: <WalletIcon /> },
  { href: "/policies", label: "Policies", icon: <ShieldIcon /> },
  { href: "/cleanup", label: "Clean up", icon: <BroomIcon /> },
  { href: "/settings", label: "Settings", icon: <GearIcon /> },
];

export interface ShellAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export function AppShell({ children, actions }: { children: ReactNode; actions?: ShellAction[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useWalletStatus();
  const session = useWalletSession();
  const walletActions = useWalletActions();

  useEffect(() => {
    if (status === "disconnected") router.replace("/app");
  }, [status, router]);

  if (status !== "connected" || !session) {
    return (
      <main
        style={{
          padding: 120,
          color: "var(--muted)",
          background: "var(--neo-bg)",
          minHeight: "100vh",
        }}
      >
        {status === "loading" ? "Restoring your session…" : "Redirecting…"}
      </main>
    );
  }

  const short = `${session.accountId.slice(0, 5)}…${session.accountId.slice(-5)}`;

  return (
    <div className="shell">
      {/* Sidebar (→ bottom tab bar on mobile) */}
      <aside className="shell-side">
        <Link href="/" aria-label="VELA home" className="shell-logo">
          <Logo height={38} />
        </Link>
        {nav.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`shell-navitem${active ? " active" : ""}`}
            >
              {item.icon}
              <span className="shell-tablabel">{item.label}</span>
            </Link>
          );
        })}
      </aside>

      {/* Main column */}
      <div className="shell-main">
        <header className="shell-top">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Logo shows here on mobile (sidebar logo is hidden) */}
            <Link
              href="/"
              aria-label="VELA home"
              className="shell-mobile-logo"
              style={{ display: "none" }}
            >
              <Logo height={26} />
            </Link>
            <div>
              <button
                className="mono neo-btn"
                onClick={() => void navigator.clipboard.writeText(session.accountId)}
                style={{ padding: "8px 14px", fontSize: 13, fontWeight: 700 }}
                title={`${session.accountId} · click to copy`}
              >
                {short} ⧉
              </button>
              <p
                className="eyebrow"
                style={{
                  marginTop: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 10,
                }}
              >
                <span className="pulse"></span> {session.network} network
              </p>
            </div>
          </div>

          <div className="shell-actions">
            {actions?.map((a) =>
              a.primary ? (
                <button key={a.label} onClick={a.onClick} className="btn btn-signal btn-sm">
                  {a.label}
                </button>
              ) : (
                <button
                  key={a.label}
                  onClick={a.onClick}
                  className="neo-btn"
                  style={{ padding: "8px 16px", fontSize: 14, fontWeight: 700 }}
                >
                  {a.label}
                </button>
              ),
            )}
            <ThemeToggle />
            <button
              onClick={() => void walletActions.disconnect()}
              className="neo-btn"
              style={{ padding: "8px 16px", fontSize: 14, fontWeight: 700 }}
            >
              Disconnect
            </button>
          </div>
        </header>

        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="neo-btn"
      aria-label="Toggle light/dark theme"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      style={{
        width: 40,
        height: 40,
        display: "grid",
        placeItems: "center",
        color: "var(--signal)",
      }}
    >
      {theme === "dark" ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

/* Line icons (design.md §5: stroke currentColor, 2px) */
function WalletIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18M16 14h.01" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function BroomIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M19 4l-7 7M6 20l-2-2 6-6 4 4-6 6-2-2zM10 14l4 4" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}
