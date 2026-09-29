/** GitHub star count for the nav's Developers → GitHub link.
 *
 * Fetched on the SERVER, not the browser: GitHub's unauthenticated API allows
 * 60 requests/hour PER IP, so a client-side fetch would burn one visitor's
 * quota per page load and rate-limit anyone behind a shared NAT. Server-side
 * with `revalidate` means one request per hour for ALL visitors, and the
 * number is in the HTML on first paint rather than popping in late.
 */

/** The repo whose stars the nav shows. The nav's GitHub link points here too —
 *  keep the two in sync, or the badge advertises a different repo than it
 *  opens. */
export const STARS_REPO = "Vellar-Wallet/vellar-facilitator";

/** Seconds between refetches. An hour: star counts move slowly, and this is
 *  social proof, not a live metric. */
const REVALIDATE_SECONDS = 3600;

/**
 * Returns the repo's star count, or `null` if it can't be determined.
 *
 * Never throws. GitHub being down, rate-limiting us, or changing its response
 * shape must not break the nav — the caller renders nothing on `null`, so the
 * failure mode is "no badge", never "no navigation". This is the whole reason
 * the return type is nullable rather than a `0` fallback: `0` would render a
 * badge claiming zero stars, which is worse than showing none at all.
 */
export async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${STARS_REPO}`, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub asks for a UA and may reject requests without one.
        "User-Agent": "vellar-landing",
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // Defensive: only trust a finite non-negative number. A changed payload
    // shape should degrade to "no badge", not render `undefined` or `NaN`.
    const count = (body as { stargazers_count?: unknown })?.stargazers_count;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return null;
    }
    return Math.floor(count);
  } catch {
    return null;
  }
}

/** Compact display form: 1234 → "1.2k". Below 1000 renders as-is, so today's
 *  two-digit count is exact and the badge doesn't need revisiting if the repo
 *  takes off. */
export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  // One decimal below 10k ("1.2k"), none above ("12k") — same convention
  // GitHub's own UI uses.
  return k < 10 ? `${k.toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(k)}k`;
}
