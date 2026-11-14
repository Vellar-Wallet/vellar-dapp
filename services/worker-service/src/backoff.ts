/**
 * Exponential backoff with full jitter for job retries.
 *
 * Used by the reaper (M7) to calculate how long a stranded job should wait
 * before re-claiming, based on how many times it has already been attempted.
 */

import { retryWithJitter } from "@vellar/service-kit";

/**
 * Calculates exponential backoff delay with full jitter.
 *
 * Delegates to the shared `retryWithJitter` helper in
 * packages/service-kit (issue #549) so the jittered-retry pattern is
 * defined once rather than duplicated across services.
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
  return retryWithJitter(attempt, { baseDelayMs, maxDelayMs });
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
export const BACKOFF_CONFIG = Object.freeze({
  /** Maximum number of attempts including the first (M7). */
  MAX_ATTEMPTS: 5,

  /** Base delay for exponential backoff in milliseconds. */
  BASE_DELAY_MS: 1_000,

  /** Maximum delay cap per reclaim in milliseconds. */
  MAX_DELAY_MS: 30_000,

  /** Total theoretical maximum retry window (sum of all max delays). */
  MAX_RETRY_WINDOW_MS: 120_000,
} as const);

/**
 * Terminal reason surfaced when cumulative retry time exceeds the configured ceiling.
 */
export type RetryExhaustedReason = "retry_window_exceeded";

/**
 * Configuration for evaluating a retry attempt against both the per-attempt
 * delay cap and the total cumulative retry-time ceiling for a job (#688).
 */
export interface RetryBackoffOptions {
  /** Base delay for exponential backoff in ms (default: BACKOFF_CONFIG.BASE_DELAY_MS). */
  baseDelayMs?: number;
  /** Maximum per-attempt delay cap in ms (default: BACKOFF_CONFIG.MAX_DELAY_MS). */
  maxDelayMs?: number;
  /** Configurable ceiling on total cumulative retry time across all attempts in ms (default: BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS). */
  maxRetryWindowMs?: number;
  /** Cumulative retry time already elapsed across prior attempts for this job in ms (default: 0). */
  elapsedMs?: number;
}

/**
 * Distinct decision returned by `evaluateRetryBackoff` (#688):
 * - `"retry"` when the job + scheduled backoff delay stay within `maxRetryWindowMs`
 * - `"timeout_exhausted"` once cumulative retry time exceeds `maxRetryWindowMs`
 */
export type RetryBackoffDecision =
  | {
      readonly status: "retry";
      readonly delayMs: number;
      readonly cumulativeElapsedMs: number;
      readonly remainingBudgetMs: number;
      readonly maxRetryWindowMs: number;
    }
  | {
      readonly status: "timeout_exhausted";
      readonly reason: RetryExhaustedReason;
      readonly elapsedMs: number;
      readonly attemptedDelayMs?: number;
      readonly maxRetryWindowMs: number;
    };

/**
 * Stateful per-job tracker that accumulates elapsed retry time across multiple
 * attempts and enforces the configurable total retry-time ceiling (#688).
 */
export interface RetryBudgetTracker {
  /** Zero-based index of the next retry attempt to evaluate. */
  readonly attempts: number;
  /** Total cumulative retry time accrued by this job so far in milliseconds. */
  readonly elapsedMs: number;
  /** Configured ceiling on cumulative retry time for this job in milliseconds. */
  readonly maxRetryWindowMs: number;
  /** Records additional in-flight or wait time accrued by this job in milliseconds. */
  recordElapsed(durationMs: number): number;
  /**
   * Evaluates the next retry attempt, optionally recording `additionalElapsedMs`
   * accrued before scheduling the retry. Advances `elapsedMs` and `attempts`
   * only when the retry fits within `maxRetryWindowMs`.
   */
  nextAttempt(additionalElapsedMs?: number): RetryBackoffDecision;
}

function validateNonNegativeWindow(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${value}`);
  }
}

function normalizeElapsedMs(rawElapsedMs: number): number {
  if (!Number.isFinite(rawElapsedMs)) {
    throw new RangeError(`elapsedMs must be a finite number, got ${rawElapsedMs}`);
  }
  return Math.max(0, rawElapsedMs);
}

/**
 * Evaluates a single retry attempt against both the per-attempt cap (`maxDelayMs`)
 * and the configurable ceiling on total cumulative retry time (`maxRetryWindowMs`).
 *
 * Even when every individual delay is well below `maxDelayMs`, once `elapsedMs`
 * reaches `maxRetryWindowMs` — or `elapsedMs + delayMs` would exceed
 * `maxRetryWindowMs` — a distinct `timeout_exhausted` decision is returned so
 * callers stop retrying cleanly (#688).
 */
export function evaluateRetryBackoff(
  attempt: number,
  options: RetryBackoffOptions = {},
): RetryBackoffDecision {
  const baseDelayMs = options.baseDelayMs ?? BACKOFF_CONFIG.BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? BACKOFF_CONFIG.MAX_DELAY_MS;
  const maxRetryWindowMs = options.maxRetryWindowMs ?? BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS;
  const elapsedMs = normalizeElapsedMs(options.elapsedMs ?? 0);

  validateNonNegativeWindow("maxRetryWindowMs", maxRetryWindowMs);

  if (elapsedMs >= maxRetryWindowMs) {
    return {
      status: "timeout_exhausted",
      reason: "retry_window_exceeded",
      elapsedMs,
      maxRetryWindowMs,
    };
  }

  const delayMs = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs);
  const cumulativeElapsedMs = elapsedMs + delayMs;

  if (cumulativeElapsedMs > maxRetryWindowMs) {
    return {
      status: "timeout_exhausted",
      reason: "retry_window_exceeded",
      elapsedMs,
      attemptedDelayMs: delayMs,
      maxRetryWindowMs,
    };
  }

  return {
    status: "retry",
    delayMs,
    cumulativeElapsedMs,
    remainingBudgetMs: maxRetryWindowMs - cumulativeElapsedMs,
    maxRetryWindowMs,
  };
}

/**
 * Creates a stateful retry-budget tracker for one job across multiple attempts (#688).
 */
export function createRetryBudgetTracker(
  options: Omit<RetryBackoffOptions, "elapsedMs"> & { initialElapsedMs?: number } = {},
): RetryBudgetTracker {
  const baseDelayMs = options.baseDelayMs ?? BACKOFF_CONFIG.BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? BACKOFF_CONFIG.MAX_DELAY_MS;
  const maxRetryWindowMs = options.maxRetryWindowMs ?? BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS;

  validateNonNegativeWindow("maxRetryWindowMs", maxRetryWindowMs);
  let elapsedMs = normalizeElapsedMs(options.initialElapsedMs ?? 0);
  let attempts = 0;

  const recordElapsed = (durationMs: number): number => {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError(`durationMs must be a finite non-negative number, got ${durationMs}`);
    }
    elapsedMs += durationMs;
    return elapsedMs;
  };

  return {
    get attempts() {
      return attempts;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    maxRetryWindowMs,
    recordElapsed,
    nextAttempt(additionalElapsedMs = 0): RetryBackoffDecision {
      if (additionalElapsedMs !== 0) {
        recordElapsed(additionalElapsedMs);
      }
      const decision = evaluateRetryBackoff(attempts, {
        baseDelayMs,
        maxDelayMs,
        maxRetryWindowMs,
        elapsedMs,
      });
      if (decision.status === "retry") {
        elapsedMs = decision.cumulativeElapsedMs;
        attempts += 1;
      }
      return decision;
    },
  };
}
