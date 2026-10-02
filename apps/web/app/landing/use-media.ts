"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query, hydration-safe.
 *
 * The server snapshot is always `false`, so the server render and the
 * first client render agree; the real answer arrives right after
 * hydration. That is the whole point of using `useSyncExternalStore`
 * here instead of reading `matchMedia` during render: reading it during
 * render gives the client a different first answer than the server and
 * makes React throw the tree away and rebuild it.
 *
 * Where `matchMedia` does not exist (jsdom, very old browsers) the query
 * simply never matches.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}
