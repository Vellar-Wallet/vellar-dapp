/**
 * Stop the page scrolling behind an open full-screen menu.
 *
 * `overflow: hidden` on the body is enough for native scrolling, but the
 * smooth-scroll runtime (Lenis) listens for wheel and touch itself and
 * would keep scrolling the page underneath. So this also broadcasts an
 * event that the runtime listens for (see motion.tsx), which keeps this
 * module ignorant of how scrolling is implemented and keeps the runtime
 * ignorant of who wants it paused.
 */
export const SCROLL_LOCK_EVENT = "lp:scroll-lock";

export function lockScroll(locked: boolean) {
  document.body.style.overflow = locked ? "hidden" : "";
  window.dispatchEvent(new CustomEvent<boolean>(SCROLL_LOCK_EVENT, { detail: locked }));
}
