import { normalizeOrigin } from "@vellar/permission-service";

// L3: the allowlist of web-app origins permitted to `pair` the extension.
//
// Only the Vellar web app should be able to become the extension's deep-link
// target and supply the paired wallet's rpcUrl. Any site could call `pair`
// before this gate; approval + passkey still stood between an attacker and a
// signature, but an attacker page could poison webAppOrigin/rpcUrl (L4's
// precondition). The allowlist is resolved FAIL-CLOSED, matching FIX 7's
// fail-closed boot: a production build with nothing configured refuses to
// enable pairing rather than silently falling back to localhost.
//
// This module is pure — the build mode and env string are passed in — so the
// policy is unit-testable. The extension reads import.meta.env at the single
// call site in `pairOriginPolicy()` below.

/** Local dev origins allowed to pair when nothing is configured (dev only). */
export const DEV_PAIR_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost:5173",
];

/** Sentinel: the explicit escape hatch disabled the origin restriction. */
export type PairOriginPolicy = readonly string[] | "any";

/** Thrown when a production build has no usable pair-origin allowlist and the
 * escape hatch is not set — the pairing path must not initialize (FIX 7 shape). */
export class PairOriginsMisconfiguredError extends Error {
  readonly code = "pair_origins_misconfigured";
  constructor() {
    super(
      "No web-app origins configured for pairing. Set WXT_PUBLIC_WEB_APP_ORIGINS " +
        "(comma-separated https origins) in this production build, or set " +
        "WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN=1 to explicitly disable the restriction.",
    );
    this.name = "PairOriginsMisconfiguredError";
  }
}

/** Parse a comma-separated origin list, canonicalizing each through
 * normalizeOrigin and dropping anything that isn't a clean http(s) origin.
 * A single trailing slash on an otherwise-bare origin is tolerated (operators
 * routinely paste "https://app.vellar.xyz/"), but a path/query is not. Deduped,
 * order preserved. */
function parseOrigins(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    const origin = normalizeOrigin(trimmed);
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

export interface ResolvePairOriginsInput {
  /** WXT build command: "build" is a production artifact, "serve" is dev. */
  command: "build" | "serve";
  /** Raw WXT_PUBLIC_WEB_APP_ORIGINS value (comma-separated), if any. */
  raw: string | undefined;
  /** The explicit, warned escape hatch (WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN). */
  allowAny?: boolean;
}

/**
 * Resolve the pair-origin policy fail-closed:
 * - allowAny escape hatch set        -> "any" (no restriction; caller warns).
 * - configured origins present       -> exactly those (normalized, deduped).
 * - dev build (serve), none set      -> localhost dev fallback.
 * - production build (build), none set -> THROW (refuse to enable pairing).
 */
export function resolvePairOrigins(input: ResolvePairOriginsInput): PairOriginPolicy {
  if (input.allowAny) return "any";

  const configured = input.raw ? parseOrigins(input.raw) : [];
  if (configured.length > 0) return configured;

  if (input.command === "serve") return [...DEV_PAIR_ORIGINS];

  // Production build with no usable allowlist and no escape hatch: fail closed.
  throw new PairOriginsMisconfiguredError();
}

/**
 * Read the pair-origin policy from the extension's build-time env. `COMMAND` is
 * WXT/Vite-injected at bundle time (per artifact, not spoofable by a runtime
 * env var). Throws PairOriginsMisconfiguredError in a misconfigured prod build.
 */
export function pairOriginPolicy(): PairOriginPolicy {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const command = env?.COMMAND === "serve" ? "serve" : "build";
  const raw = env?.WXT_PUBLIC_WEB_APP_ORIGINS as string | undefined;
  const allowAny = env?.WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN === "1";
  return resolvePairOrigins({ command, raw, allowAny });
}

/** True when `origin` may initiate pairing under `policy`. */
export function isPairOriginAllowed(policy: PairOriginPolicy, origin: string): boolean {
  return policy === "any" || policy.includes(origin);
}
