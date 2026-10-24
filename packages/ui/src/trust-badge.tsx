import type { CSSProperties } from "react";
import { trustSignal, type VerificationStatus } from "@vellar/verification-sdk";

// TrustBadge (technical-doc.md §5.5): the trust signal shown before a user
// interacts with a contract — during transaction approval in the extension AND
// in the web app. It lives in @vellar/ui so both surfaces render it identically
// (DRY); the status→label/tone mapping comes from @vellar/verification-sdk so the
// wording is defined once. Styling is self-contained (inline) so the badge
// looks the same in the web app and the sandboxed extension popup without
// depending on either's stylesheet.

type Tone = ReturnType<typeof trustSignal>["tone"] | "error";

const TONE_COLORS: Record<Tone, { fg: string; bg: string; dot: string }> = {
  verified: { fg: "#0b7a3b", bg: "rgba(16,185,129,0.14)", dot: "#10b981" },
  warning: { fg: "#b42318", bg: "rgba(239,68,68,0.14)", dot: "#ef4444" },
  pending: { fg: "#8a6d1a", bg: "rgba(234,179,8,0.16)", dot: "#eab308" },
  neutral: { fg: "#5b6472", bg: "rgba(100,116,139,0.14)", dot: "#94a3b8" },
  error: { fg: "#c2410c", bg: "rgba(249,115,22,0.16)", dot: "#f97316" },
};

/**
 * A verification lookup is a network round-trip, so the badge needs states that
 * are not verification outcomes: `loading` while the lookup is in flight, and
 * `error` when the lookup itself fails. `error` is deliberately distinct from
 * `unverified` — "couldn't check" is not the same claim as "checked and not
 * verified". `no_record` is likewise distinct from `unverified`: it means the
 * lookup succeeded and found no verification record at all for this contract,
 * as opposed to a contract that was explicitly checked and flagged unverified
 * (see classifyContractTrust in the extension's lib/verification.ts).
 */
export type TrustBadgeStatus = VerificationStatus | "loading" | "error" | "no_record";

function signalFor(status: TrustBadgeStatus): { label: string; tone: Tone } {
  if (status === "loading") return { label: "Checking verification…", tone: "pending" };
  if (status === "error") return { label: "Couldn't check verification", tone: "error" };
  if (status === "no_record") return { label: "No verification record", tone: "neutral" };
  return trustSignal(status);
}

export interface TrustBadgeProps {
  status: TrustBadgeStatus;
  /** Compact rendering for tight spots (extension approval header). */
  size?: "sm" | "md";
  /** Optional override label (defaults to the trustSignal label). */
  label?: string;
  style?: CSSProperties;
}

export function TrustBadge({ status, size = "md", label, style }: TrustBadgeProps) {
  const signal = signalFor(status);
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
