import { Suspense } from "react";
import { LpNav } from "./lp-nav";
import { getStarCount } from "./github-stars";

/** Fetches the star count and renders the nav with it.
 *
 *  Split out of LpShell so the await lives in one leaf component rather than
 *  making the whole page tree async — see LpShell's own comment for why that
 *  matters (Next's testing guide: async Server Components aren't supported by
 *  unit-test tooling). */
async function NavWithCount() {
  const stars = await getStarCount();
  return <LpNav stars={stars} />;
}

/**
 * The nav, with its GitHub star count.
 *
 * Wrapped in Suspense with the countless nav as the fallback: navigation is
 * the one thing on the page that must never wait on a third-party API. If
 * api.github.com is slow, the nav streams immediately without the badge and
 * the count fills in — rather than the whole page blocking on it. On a cache
 * hit (the common case — the count is revalidated hourly) the fallback is
 * never shown.
 */
export function LpNavWithStars() {
  return (
    <Suspense fallback={<LpNav />}>
      <NavWithCount />
    </Suspense>
  );
}
