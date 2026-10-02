import { STARS_REPO } from "./github-stars";

/** One entry in the site navigation, shared by the desktop drip menu and
 *  the mobile curtain menu so the two can never drift apart.
 *
 *  `section` marks an anchor on the landing page: there the link scrolls
 *  smoothly and takes part in scroll-spy highlighting; from any other page
 *  it is an ordinary link to `/#section`.
 *
 *  `desc` is the italic serif line that rolls in under the label when the
 *  link is hovered or focused. It is deliberately short and says only what
 *  the destination is. */
export type NavLink = {
  label: string;
  href: string;
  desc: string;
  section?: string;
};

export const GITHUB_URL = `https://github.com/${STARS_REPO}`;

export const NAV_LINKS: readonly NavLink[] = [
  { label: "How it works", href: "/#how", section: "how", desc: "Verify, settle, list" },
  { label: "Bazaar", href: "/#bazaar", section: "bazaar", desc: "Sellers and agents" },
  { label: "Docs", href: "https://docs.vellar.xyz/", desc: "Quickstart and reference" },
  {
    label: "Playground",
    href: "https://playground.vellar.xyz/",
    desc: "Try it on testnet",
  },
  { label: "GitHub", href: GITHUB_URL, desc: "Read the source" },
  { label: "About", href: "/about", desc: "About Vellar" },
];

/** Section ids the nav tracks for scroll-spy highlighting. */
export const NAV_SECTION_IDS: readonly string[] = NAV_LINKS.flatMap((l) =>
  l.section ? [l.section] : [],
);

/** Internal routes get client navigation; everything else is a plain,
 *  same-tab link (these are Vellar's own properties). */
export function isInternal(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}
