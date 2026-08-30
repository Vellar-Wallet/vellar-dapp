// Shared retry-with-backoff utility (issue #352). Extracted here so
// wallet-service, lifecycle-service, and any future service share one
// implementation rather than evolving separate copies.
//
// Design principles:
//  - PURE scheduling: no imports, no process-level coupling. The only I/O is
//    the caller-supplied `fn` and an optional `sleep` override for tests.
//  - Full jitter by default: `delay = random(0, min(maxDelayMs, baseDelayMs *
//    2^attempt))`. Full jitter outperforms capped and equal jitter for
//    thundering-herd prevention (see AWS Architecture Blog, 2015).
//  - Caller controls retryability: an `isRetryable` predicate lets call-sites
//    abort immediately on non-transient errors (e.g. 400 Bad Request vs 503).
//  - Signal-safe: an AbortSignal stops further attempts without swallowing the
//    abort error so callers can observe cancellation.

export class RetryAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryAbortedError";
  }
}

export class MaxRetriesExceededError extends Error {
  /** The error from the LAST attempt. */
  readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${reason}`);
    this.name = "MaxRetriesExceededError";
    this.cause = cause;
  }
}

export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first). Must be ≥ 1.
   * Default: 4 (3 retries after the initial call).
   */
  maxAttempts?: number;

  /**
   * Base delay in milliseconds for the first retry. The ceiling for attempt N
   * (0-indexed) is `baseDelayMs * 2^N`, capped at `maxDelayMs`.
   * Default: 200 ms.
   */
  baseDelayMs?: number;

  /**
   * Absolute ceiling on the computed delay, in milliseconds. Prevents
   * exponential growth from producing multi-minute waits at high attempt counts.
   * Default: 10 000 ms (10 s).
   */
  maxDelayMs?: number;

  /**
   * When true the delay is the full computed ceiling (no jitter). Disable only
   * when deterministic timing is needed (e.g. in integration tests against a
   * real upstream). Production code should leave this false.
   * Default: false (full jitter enabled).
   */
  noJitter?: boolean;

  /**
   * Predicate called with the thrown error before sleeping. Return false to
   * surface the error immediately without further retries (e.g. 400 Bad Request
   * is never retryable, but 503 is). Default: always retry.
   */
  isRetryable?: (err: unknown) => boolean;

  /**
   * An AbortSignal that cancels pending retries. When the signal fires between
   * attempts the function throws `RetryAbortedError`.
   */
  signal?: AbortSignal;

  /**
   * Override the sleep implementation. Defaults to a `setTimeout`-based Promise.
   * Tests pass a zero-delay stub to keep suites fast.
   */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` up to `maxAttempts` times with exponential back-off and full jitter
 * between each attempt.
 *
 * @example
 * ```ts
 * import { retryWithBackoff } from "@vellar/service-kit";
 *
 * const result = await retryWithBackoff(() => fetch(url), {
 *   maxAttempts: 5,
 *   baseDelayMs: 300,
 *   isRetryable: (err) => !(err instanceof BadRequestError),
 * });
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (maxAttempts < 1) throw new RangeError("maxAttempts must be ≥ 1");

  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const noJitter = options.noJitter ?? false;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check for cancellation before each attempt (including the first).
    if (signal?.aborted) {
      throw new RetryAbortedError("Retry cancelled before attempt");
    }

    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Non-retryable: surface immediately.
      if (!isRetryable(err)) throw err;

      // No more retries left.
      if (attempt === maxAttempts - 1) break;

      // Compute delay: full jitter over [0, min(maxDelay, base * 2^attempt)].
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const delay = noJitter ? cap : Math.random() * cap;

      // Honour abort signal during the sleep window.
      if (signal?.aborted) {
        throw new RetryAbortedError("Retry cancelled before sleep");
      }
      await sleep(delay);

      // Check again after waking — the signal may have fired while sleeping.
      if (signal?.aborted) {
        throw new RetryAbortedError("Retry cancelled after sleep");
      }
    }
  }

  throw new MaxRetriesExceededError(maxAttempts, lastErr);
}
