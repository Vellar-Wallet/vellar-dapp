import type { CSSProperties } from "react";
import { trustSignal, type VerificationStatus } from "@vellar/verification-sdk";

// TrustBadge (technical-doc.md §5.5): the trust signal shown before a user
// interacts with a contract — during transaction approval in the extension AND
// in the web app. It lives in @vellar/ui so both surfaces render it identically
// (DRY); the status→label/tone mapping comes from @vellar/verification-sdk so the
// wording is defined once. Styling is self-contained (inline) so the badge
// looks the same in the web app and the sandboxed extension popup without
// depending on either's stylesheet.

export type TrustBadgeStatus = VerificationStatus | "loading" | "error";

export type TrustBadgeTone = ReturnType<typeof trustSignal>["tone"] | "loading" | "error";

const TONE_COLORS: Record<TrustBadgeTone, { fg: string; bg: string; dot: string }> = {
  verified: { fg: "#0b7a3b", bg: "rgba(16,185,129,0.14)", dot: "#10b981" },
  warning: { fg: "#b42318", bg: "rgba(239,68,68,0.14)", dot: "#ef4444" },
  pending: { fg: "#8a6d1a", bg: "rgba(234,179,8,0.16)", dot: "#eab308" },
  neutral: { fg: "#5b6472", bg: "rgba(100,116,139,0.14)", dot: "#94a3b8" },
  loading: { fg: "#1d4ed8", bg: "rgba(59,130,246,0.14)", dot: "#3b82f6" },
  error: { fg: "#9a3412", bg: "rgba(249,115,22,0.16)", dot: "#f97316" },
};

export interface TrustBadgeProps {
  status?: TrustBadgeStatus;
  /** Explicit loading flag while a verification status lookup is in flight. */
  loading?: boolean;
  /** Explicit error flag or message when the verification lookup itself fails. */
  error?: boolean | string;
  /** Compact rendering for tight spots (extension approval header). */
  size?: "sm" | "md";
  /** Optional override label (defaults to the resolved signal label). */
  label?: string;
  style?: CSSProperties;
}

export function resolveTrustBadgeSignal(
  status: TrustBadgeStatus | undefined,
  options?: { loading?: boolean; error?: boolean | string },
): {
  status: TrustBadgeStatus;
  label: string;
  tone: TrustBadgeTone;
  isBusy: boolean;
} {
  if (options?.loading || status === "loading") {
    return {
      status: "loading",
      label: "Checking verification…",
      tone: "loading",
      isBusy: true,
    };
  }
  if (options?.error || status === "error") {
    const customError =
      typeof options?.error === "string" && options.error.trim().length > 0
        ? options.error.trim()
        : undefined;
    return {
      status: "error",
      label: customError ?? "Verification status unavailable",
      tone: "error",
      isBusy: false,
    };
  }
  const effectiveStatus: VerificationStatus = status ?? "unverified";
  const signal = trustSignal(effectiveStatus);
  return {
    status: effectiveStatus,
    label: signal.label,
    tone: signal.tone,
    isBusy: signal.tone === "pending",
  };
}

export function TrustBadge({ status, loading, error, size = "md", label, style }: TrustBadgeProps) {
  const signal = resolveTrustBadgeSignal(status, { loading, error });
  const colors = TONE_COLORS[signal.tone];
  const pad = size === "sm" ? "2px 8px" : "4px 10px";
  const font = size === "sm" ? 12 : 13;
  const dot = size === "sm" ? 6 : 8;
  const displayLabel = label ?? signal.label;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-busy={signal.isBusy ? "true" : "false"}
      aria-label={`Contract trust status: ${displayLabel}`}
      data-status={signal.status}
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
          // A pending or loading badge pulses so in-flight lookups read as live, not stalled.
          animation:
            signal.tone === "pending" || signal.tone === "loading"
              ? "vela-trust-pulse 1.4s ease-in-out infinite"
              : undefined,
        }}
      />
      {displayLabel}
    </span>
  );
}
