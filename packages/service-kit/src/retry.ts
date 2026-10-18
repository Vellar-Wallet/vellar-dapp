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

export type JitterMode = "full" | "equal" | "none";

export interface BackoffDelayOptions {
  /**
   * Base delay in milliseconds for the first retry (attempt 0).
   * Alias for `baseDelayMs`. Default: 200 ms.
   */
  baseMs?: number;
  baseDelayMs?: number;

  /**
   * Maximum ceiling on computed delay in milliseconds.
   * Alias for `maxDelayMs`. Default: 10 000 ms (10 s).
   */
  maxMs?: number;
  maxDelayMs?: number;

  /**
   * Jitter strategy used to decorrelate concurrent retries:
   * - `"full"` (or `true`, default): uniform random integer in `[0, cap]`
   * - `"equal"`: half deterministic + half random in `[floor(cap / 2), cap]`
   * - `"none"` (or `false`): deterministic `cap` (no jitter)
   */
  jitter?: JitterMode | boolean;

  /**
   * Legacy flag that disables jitter when true (`jitter: "none"`).
   */
  noJitter?: boolean;

  /**
   * Injectable random number generator returning `[0, 1)`.
   * Defaults to `Math.random`.
   */
  random?: () => number;
}

export interface RetryOptions extends BackoffDelayOptions {
  /**
   * Maximum number of attempts (including the first). Must be ≥ 1.
   * Default: 4 (3 retries after the initial call).
   */
  maxAttempts?: number;

  /**
   * Predicate called with the thrown error before sleeping. Return false to
   * surface the error immediately without further retries (e.g. 400 Bad Request
   * is never retryable, but 503 is). Default: always retry.
   */
  isRetryable?: (err: unknown, attempt: number) => boolean;

  /**
   * Optional hook invoked before sleeping between retry attempts.
   */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void | Promise<void>;

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

function resolveJitterMode(options: BackoffDelayOptions): JitterMode {
  if (options.noJitter === true || options.jitter === false || options.jitter === "none") {
    return "none";
  }
  if (options.jitter === "equal") {
    return "equal";
  }
  return "full";
}

/**
 * Compute the backoff delay (in integer milliseconds) for a 0-indexed retry
 * `attempt` using exponential growth capped at `maxMs` (`maxDelayMs`) and
 * the configured `jitter` mode (`"full"` by default).
 */
export function computeBackoffDelay(attempt: number, options: BackoffDelayOptions = {}): number {
  const baseMs = options.baseMs ?? options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxMs = options.maxMs ?? options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (maxMs <= 0 || baseMs <= 0) return 0;

  const exponential = baseMs * Math.pow(2, attempt);
  const cap = Math.max(0, Math.min(maxMs, exponential));
  const mode = resolveJitterMode(options);
  const rand = options.random ?? (() => Math.random());

  if (mode === "none") {
    return Math.floor(cap);
  }
  if (mode === "equal") {
    const half = cap / 2;
    return Math.min(Math.floor(cap), Math.floor(half + rand() * half));
  }
  return Math.min(Math.floor(cap), Math.floor(rand() * cap));
}

/**
 * Run `fn` up to `maxAttempts` times with exponential back-off and configurable
 * jitter (`"full"` by default) between each attempt.
 *
 * @example
 * ```ts
 * import { retryWithJitter } from "@vellar/service-kit";
 *
 * const result = await retryWithJitter(() => fetch(url), {
 *   maxAttempts: 5,
 *   baseMs: 300,
 *   maxMs: 5_000,
 *   jitter: "full",
 *   isRetryable: (err) => !(err instanceof BadRequestError),
 * });
 * ```
 */
export async function retryWithJitter<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (maxAttempts < 1) throw new RangeError("maxAttempts must be ≥ 1");

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
      return await fn(attempt);
    } catch (err) {
      lastErr = err;

      // Non-retryable: surface immediately.
      if (!isRetryable(err, attempt)) throw err;

      // No more retries left.
      if (attempt === maxAttempts - 1) break;

      const delay = computeBackoffDelay(attempt, options);

      await options.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });

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

/**
 * Backwards-compatible alias for `retryWithJitter`.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  return retryWithJitter(fn, options);
}
