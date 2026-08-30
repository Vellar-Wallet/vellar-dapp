// Circuit breaker for calls to a downstream service (#326). A downstream
// outage otherwise cascades into slow gateway responses — every caller
// waits out the same timeout against the same broken dependency. Once a
// configured number of consecutive failures is seen, the breaker OPENs and
// every call fails fast (no network attempt at all) until a cooldown
// elapses; it then allows exactly one HALF_OPEN trial call to decide
// whether to CLOSE (resume normal traffic) or re-OPEN.
//
// Deliberately dependency-free (no `opossum`/`cockatiel` etc.) — the state
// machine itself is small, and this repo has no existing circuit-breaker
// library dependency to build on; see budget.ts for the same
// pure-function-plus-explicit-clock style this follows.

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker open. */
  failureThreshold: number;
  /** Once open, how long (ms) before allowing a half-open trial call. */
  cooldownMs: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Called on every state transition — the "metric tracking circuit
   * breaker state changes" #326 asks for. Not called for a call that
   * doesn't change state (e.g. a second consecutive failure while already
   * open). */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`circuit is open; retry after ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  /** Throws `CircuitOpenError` (fast-fail, no call attempted) when open and
   * the cooldown hasn't elapsed yet. Otherwise runs `fn`, recording the
   * outcome against the breaker's state machine. A half-open trial that
   * succeeds closes the breaker; one that fails re-opens it (a fresh
   * cooldown window starting now, not extending the original). */
  execute<T>(fn: () => Promise<T>): Promise<T>;
  /** Lower-level pair `execute` is built on, for callers that can't wrap
   * the call itself in a promise this module controls — e.g.
   * `@fastify/http-proxy`, which reports success/failure via separate
   * `onResponse`/`onError` hooks rather than a promise this code awaits.
   * Call `beforeCall()` where `execute` would check state (throws
   * `CircuitOpenError` the same way); call `recordOutcome(...)` from
   * whichever hook fires once the real call's outcome is known. */
  beforeCall(): void;
  recordOutcome(outcome: "success" | "failure"): void;
}

/**
 * Creates a breaker starting `closed`. Every consecutive failure while
 * closed increments an internal counter; reaching `failureThreshold` opens
 * the breaker with a cooldown clock started at that moment. Any success
 * while closed resets the counter to 0 (an intermittent failure that never
 * reaches the threshold never trips the breaker) — this is a consecutive-
 * failure count, not a rolling error rate.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const now = options.now ?? Date.now;
  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;

  function transition(to: CircuitState) {
    if (to === state) return;
    const from = state;
    state = to;
    options.onStateChange?.(from, to);
  }

  function beforeCall(): void {
    if (state === "open") {
      const elapsed = now() - openedAt;
      if (elapsed < options.cooldownMs) {
        throw new CircuitOpenError(options.cooldownMs - elapsed);
      }
      // Cooldown elapsed — allow exactly this one trial call through.
      transition("half_open");
    }
  }

  function recordOutcome(outcome: "success" | "failure"): void {
    if (outcome === "success") {
      // A successful call, whether closed or the half-open trial, means
      // the dependency is healthy again.
      consecutiveFailures = 0;
      transition("closed");
      return;
    }
    if (state === "half_open") {
      // The trial failed — re-open with a fresh cooldown window.
      openedAt = now();
      transition("open");
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= options.failureThreshold) {
        openedAt = now();
        transition("open");
      }
    }
  }

  return {
    get state() {
      return state;
    },

    beforeCall,
    recordOutcome,

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      beforeCall();
      try {
        const result = await fn();
        recordOutcome("success");
        return result;
      } catch (err) {
        recordOutcome("failure");
        throw err;
      }
    },
  };
}

export interface CircuitBreakerLimits {
  failureThreshold: number;
  cooldownMs: number;
}

/** Build breaker limits from env, mirroring `budgetLimitsFromEnv`'s
 * env-with-explicit-defaults shape. */
export function circuitBreakerLimitsFromEnv(
  vars: { failureThresholdVar: string; cooldownMsVar: string },
  defaults: { defaultFailureThreshold: number; defaultCooldownMs: number },
  env: Record<string, string | undefined> = process.env,
): CircuitBreakerLimits {
  const thresholdRaw = env[vars.failureThresholdVar];
  const cooldownRaw = env[vars.cooldownMsVar];
  const failureThreshold = thresholdRaw ? Number(thresholdRaw) : defaults.defaultFailureThreshold;
  const cooldownMs = cooldownRaw ? Number(cooldownRaw) : defaults.defaultCooldownMs;
  return {
    failureThreshold:
      Number.isFinite(failureThreshold) && failureThreshold > 0
        ? failureThreshold
        : defaults.defaultFailureThreshold,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : defaults.defaultCooldownMs,
  };
}
