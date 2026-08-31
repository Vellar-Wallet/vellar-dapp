/**
 * Exponential backoff with full jitter for job retries.
 *
 * Used by the reaper (M7) to calculate how long a stranded job should wait
 * before re-claiming, based on how many times it has already been attempted.
 */

/**
 * Calculates exponential backoff delay with full jitter.
 *
 * Formula: random(0, min(cap, base * 2^attempt))
 *
 * Full jitter prevents thundering herd — all retrying jobs do NOT fire
 * simultaneously after a downstream outage or worker crash.
 *
 * @param attempt - Zero-based attempt number (0 = first retry after stranded)
 * @param baseDelayMs - Base delay in ms (default: 1000ms)
 * @param maxDelayMs - Maximum delay cap in ms (default: 30s)
 * @returns Delay in milliseconds before next retry
 *
 * @example
 * calculateBackoffDelay(0) // 0–1000ms (first reclaim attempt)
 * calculateBackoffDelay(1) // 0–2000ms (second reclaim attempt)
 * calculateBackoffDelay(2) // 0–4000ms (third reclaim attempt)
 * calculateBackoffDelay(5) // 0–30000ms (capped, exponential would exceed)
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
): number {
  // Exponential growth: base * 2^attempt
  const exponential = baseDelayMs * Math.pow(2, attempt);
  // Cap at maximum to prevent unbounded growth
  const capped = Math.min(exponential, maxDelayMs);
  // Full jitter: random integer in [0, capped]
  return Math.floor(Math.random() * capped);
}

/**
 * Backoff configuration for verification job retries.
 *
 * Policy (idea.md §13, M7 security-audit.md):
 * - Max 5 attempts (1 initial + 4 retries after stranded reclaims)
 * - Exponential backoff with full jitter per reclaim
 * - Maximum per-reclaim delay: ~30 seconds
 * - Maximum total retry window: ~2 minutes across all attempts
 * - After MAX_ATTEMPTS, job moves to dead-letter queue (never retried)
 *
 * This prevents a poisoned job from looping forever and avoids thundering
 * herd when multiple workers encounter an outage simultaneously.
 */
export const BACKOFF_CONFIG = {
  /** Maximum number of attempts including the first (M7). */
  MAX_ATTEMPTS: 5,

  /** Base delay for exponential backoff in milliseconds. */
  BASE_DELAY_MS: 1_000,

  /** Maximum delay cap per reclaim in milliseconds. */
  MAX_DELAY_MS: 30_000,

  /** Total theoretical maximum retry window (sum of all max delays). */
  MAX_RETRY_WINDOW_MS: 120_000,
} as const;
