import type { CSSProperties } from "react";
import { trustSignal, type VerificationStatus } from "@vela/verification-sdk";

// TrustBadge (technical-doc.md §5.5): the trust signal shown before a user
// interacts with a contract — during transaction approval in the extension AND
// in the web app. It lives in @vela/ui so both surfaces render it identically
// (DRY); the status→label/tone mapping comes from @vela/verification-sdk so the
// wording is defined once. Styling is self-contained (inline) so the badge
// looks the same in the web app and the sandboxed extension popup without
// depending on either's stylesheet.

const TONE_COLORS: Record<
  ReturnType<typeof trustSignal>["tone"],
  { fg: string; bg: string; dot: string }
> = {
  verified: { fg: "#0b7a3b", bg: "rgba(16,185,129,0.14)", dot: "#10b981" },
  warning: { fg: "#b42318", bg: "rgba(239,68,68,0.14)", dot: "#ef4444" },
  pending: { fg: "#8a6d1a", bg: "rgba(234,179,8,0.16)", dot: "#eab308" },
  neutral: { fg: "#5b6472", bg: "rgba(100,116,139,0.14)", dot: "#94a3b8" },
};

export interface TrustBadgeProps {
  status: VerificationStatus;
  /** Compact rendering for tight spots (extension approval header). */
  size?: "sm" | "md";
  /** Optional override label (defaults to the trustSignal label). */
  label?: string;
  style?: CSSProperties;
}

export function TrustBadge({ status, size = "md", label, style }: TrustBadgeProps) {
  const signal = trustSignal(status);
  const colors = TONE_COLORS[signal.tone];
  const pad = size === "sm" ? "2px 8px" : "4px 10px";
  const font = size === "sm" ? 12 : 13;
  const dot = size === "sm" ? 6 : 8;

  return (
    <span
      role="status"
      aria-label={`Contract trust status: ${signal.label}`}
      data-status={status}
      data-tone={signal.tone}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: pad,
        borderRadius: 999,
        fontSize: font,
        fontWeight: 600,
        lineHeight: 1.2,
        color: colors.fg,
        background: colors.bg,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: dot,
          height: dot,
          borderRadius: "50%",
          background: colors.dot,
          // A pending badge pulses so "in progress" reads as live, not stalled.
          animation:
            signal.tone === "pending" ? "vela-trust-pulse 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {label ?? signal.label}
    </span>
  );
}
