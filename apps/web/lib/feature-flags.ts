// Feature flags — gradual rollout gating (issue #335).
//
// The policy builder UI (app/policies/page.tsx) needs a gradual rollout
// mechanism rather than a hard cutover for all users. This module provides
// two gating strategies that combine into one decision:
//
//   1. Allowlist — a fixed set of account IDs (e.g. internal/beta testers)
//      always see the flagged UI, regardless of the percentage rollout.
//   2. Percentage rollout — a stable hash of the account's own accountId
//      buckets it into [0, 100). The same account ALWAYS lands in the same
//      bucket (the hash is deterministic, not randomized per page load), so
//      a user's experience doesn't flicker between the old and new UI on
//      every refresh — the property a gradual rollout actually needs.
//
// Configured via NEXT_PUBLIC_* env vars, matching every other client
// config value in lib/config.ts (NEXT_PUBLIC_* vars are inlined at build
// time by Next.js).

export interface FeatureFlagConfig {
  /** 0-100. Percentage of accounts (by stable hash) that see the flagged UI. */
  rolloutPercent: number;
  /** Account IDs that always see the flagged UI, independent of rolloutPercent. */
  allowlist: string[];
}

const FLAG_ENV_PREFIX = "NEXT_PUBLIC_FLAG_";

/**
 * Reads a flag's config from env vars:
 *   NEXT_PUBLIC_FLAG_<NAME>_ROLLOUT_PERCENT  (default 0 — off unless configured)
 *   NEXT_PUBLIC_FLAG_<NAME>_ALLOWLIST        (comma-separated account IDs)
 *
 * `name` is upper-snake-cased internally, so callers can pass either form
 * ("policyBuilderV2" or "POLICY_BUILDER_V2") and get the same env var names.
 */
export function readFlagConfig(name: string, env: Record<string, string | undefined> = process.env): FeatureFlagConfig {
  const key = toEnvKey(name);
  const rolloutRaw = env[`${FLAG_ENV_PREFIX}${key}_ROLLOUT_PERCENT`];
  const allowlistRaw = env[`${FLAG_ENV_PREFIX}${key}_ALLOWLIST`];

  let rolloutPercent = 0;
  if (rolloutRaw !== undefined && rolloutRaw !== "") {
    const parsed = Number(rolloutRaw);
    // clamp: a misconfigured value (negative, >100, NaN) must fail closed
    // toward "fewer people see it" rather than silently rolling out to
    // everyone or crashing the page.
    rolloutPercent = Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
  }

  const allowlist = (allowlistRaw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return { rolloutPercent, allowlist };
}

function toEnvKey(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

/**
 * Stable, deterministic bucket in [0, 100) for `accountId`. Same accountId
 * always produces the same bucket — this is NOT cryptographic, just a
 * simple, fast, deterministic string hash (FNV-1a), which is exactly what a
 * rollout bucket needs and nothing more.
 */
export function bucketFor(accountId: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < accountId.length; i++) {
    hash ^= accountId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // >>> 0 converts to unsigned before the modulo, so the bucket is always
  // non-negative regardless of hash's sign after Math.imul.
  return (hash >>> 0) % 100;
}

/**
 * Whether `accountId` should see the flagged UI, given `config`.
 * Allowlist wins outright; otherwise the account's stable bucket must fall
 * inside the configured rollout percentage. `accountId` of `null` (no
 * connected wallet — e.g. before wallet connect completes) never sees the
 * flagged UI: a rollout decision requires an identity to be stable against,
 * and there is none yet.
 */
export function isFlagEnabled(config: FeatureFlagConfig, accountId: string | null): boolean {
  if (!accountId) return false;
  if (config.allowlist.includes(accountId)) return true;
  return bucketFor(accountId) < config.rolloutPercent;
}
