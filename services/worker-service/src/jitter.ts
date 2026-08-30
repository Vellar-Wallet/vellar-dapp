// Randomized jitter for background-job retry/reap intervals (issue #331).
//
// A fixed retry/reap interval synchronizes across every worker-service
// replica that boots around the same time (e.g. a rolling deploy): they all
// sweep at the same wall-clock moments, turning a routine reclaim sweep into
// a thundering-herd spike against Postgres. Jitter spreads that out.

/**
 * Returns `baseMs` adjusted by a random offset within `[-boundMs, +boundMs]`,
 * clamped to never go below `minMs` (a sweep interval must stay positive and
 * meaningfully non-zero — jitter should smear timing, not create a busy
 * loop).
 *
 * `boundMs` bounds jitter as an ABSOLUTE duration (not a percentage of
 * `baseMs`) so it stays meaningful and configurable independent of whatever
 * base interval a caller picks.
 */
export function jitteredDelayMs(
  baseMs: number,
  boundMs: number,
  options: { random?: () => number; minMs?: number } = {},
): number {
  const random = options.random ?? Math.random;
  const minMs = options.minMs ?? 0;

  // random() is [0, 1) — map to [-boundMs, +boundMs].
  const offset = (random() * 2 - 1) * boundMs;
  return Math.max(minMs, Math.round(baseMs + offset));
}
