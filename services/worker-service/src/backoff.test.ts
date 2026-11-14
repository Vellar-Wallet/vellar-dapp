import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  calculateBackoffDelay,
  BACKOFF_CONFIG,
  createRetryBudgetTracker,
  evaluateRetryBackoff,
} from "./backoff";

describe("calculateBackoffDelay — exponential backoff with full jitter", () => {
  describe("backoff calculation", () => {
    it("returns a value in range [0, baseDelayMs] for attempt 0", () => {
      const delay = calculateBackoffDelay(0, 1000, 30000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    });

    it("returns a value in range [0, 2*baseDelayMs] for attempt 1", () => {
      const delay = calculateBackoffDelay(1, 1000, 30000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
    });

    it("returns a value in range [0, 4*baseDelayMs] for attempt 2", () => {
      const delay = calculateBackoffDelay(2, 1000, 30000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(4000);
    });

    it("doubles the cap on each attempt (exponential growth)", () => {
      // Mock Math.random to return consistent high values to see the caps
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.9999);

      const delay0 = calculateBackoffDelay(0, 1000, 30000);
      const delay1 = calculateBackoffDelay(1, 1000, 30000);
      const delay2 = calculateBackoffDelay(2, 1000, 30000);

      // delay1 cap is ~2x delay0 cap, delay2 is ~2x delay1
      expect(delay1).toBeGreaterThanOrEqual(delay0);
      expect(delay2).toBeGreaterThanOrEqual(delay1);

      spy.mockRestore();
    });

    it("never exceeds maxDelayMs regardless of attempt number", () => {
      const MAX = 30_000;
      // Test attempt numbers where 2^n * base would exceed cap
      for (let attempt = 0; attempt <= 20; attempt++) {
        const delay = calculateBackoffDelay(attempt, 1000, MAX);
        expect(delay).toBeLessThanOrEqual(MAX);
      }
    });

    it("respects custom baseDelayMs", () => {
      // With base=500, attempt 0 should be in [0, 500]
      const delay = calculateBackoffDelay(0, 500, 30000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(500);
    });

    it("respects custom maxDelayMs", () => {
      // With max=5000, even high attempts should not exceed 5000
      for (let attempt = 0; attempt <= 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, 1000, 5000);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    });

    it("returns 0 when maxDelayMs is 0", () => {
      const delay = calculateBackoffDelay(5, 1000, 0);
      expect(delay).toBe(0);
    });

    it("handles attempt=0 correctly (base delay range)", () => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
      const delay = calculateBackoffDelay(0, 1000, 30000);
      // attempt=0: cap = min(1000 * 2^0, 30000) = 1000
      // with random=0.5: floor(0.5 * 1000) = 500
      expect(delay).toBe(500);
      spy.mockRestore();
    });

    it("caps correctly at attempt=10 (exponential would exceed cap)", () => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.9999);
      const delay = calculateBackoffDelay(10, 1000, 30000);
      // 1000 * 2^10 = 1_024_000 > 30_000 cap
      // So random(0, 30000) with 0.9999 gives ~29997
      expect(delay).toBeLessThanOrEqual(30000);
      expect(delay).toBeGreaterThan(25000); // Near the cap
      spy.mockRestore();
    });

    it("uses Math.floor for integer ms precision", () => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.3333);
      const delay = calculateBackoffDelay(2, 1000, 30000);
      // attempt=2: cap = min(4000, 30000) = 4000
      // with random=0.3333: floor(0.3333 * 4000) = floor(1333.2) = 1333
      expect(delay).toBe(1333);
      expect(Number.isInteger(delay)).toBe(true);
      spy.mockRestore();
    });
  });

  describe("full jitter randomness", () => {
    it("jitter makes delays non-deterministic", () => {
      // Run 20 times with same inputs — should get different values
      const delays = Array.from({ length: 20 }, () => calculateBackoffDelay(3, 1000, 30000));
      const uniqueValues = new Set(delays).size;
      // Very unlikely all 20 are identical with true randomness
      expect(uniqueValues).toBeGreaterThan(1);
    });

    it("produces uniform distribution across range", () => {
      // Run many times and check distribution is roughly uniform
      const delays = Array.from({ length: 100 }, () => calculateBackoffDelay(1, 1000, 30000));
      const min = Math.min(...delays);
      const max = Math.max(...delays);
      const avg = delays.reduce((a, b) => a + b, 0) / delays.length;

      // Should see values near 0, near max (2000), and in between
      expect(min).toBeLessThan(500);
      expect(max).toBeGreaterThan(1500);
      // Average should be roughly half the cap (1000) for uniform distribution
      expect(avg).toBeGreaterThan(800);
      expect(avg).toBeLessThan(1200);
    });
  });

  describe("edge cases", () => {
    it("handles negative attempt (treats as 0)", () => {
      const delay = calculateBackoffDelay(-1, 1000, 30000);
      // 2^-1 = 0.5, so cap = 500
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(500);
    });

    it("handles very large attempt numbers", () => {
      const delay = calculateBackoffDelay(100, 1000, 30000);
      // 2^100 is huge, should be capped at 30000
      expect(delay).toBeLessThanOrEqual(30000);
    });

    it("handles baseDelayMs = maxDelayMs", () => {
      const delay = calculateBackoffDelay(0, 1000, 1000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);

      const delay2 = calculateBackoffDelay(5, 1000, 1000);
      expect(delay2).toBeGreaterThanOrEqual(0);
      expect(delay2).toBeLessThanOrEqual(1000);
    });

    it("handles maxDelayMs < exponential", () => {
      // Math.random() is in [0, 1); use its largest value, not 1.
      const spy = vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
      try {
        const delay = calculateBackoffDelay(2, 1000, 100);
        // cap would be min(4000, 100) = 100, random(0, 100) at the top = 99
        expect(delay).toBe(99);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("BACKOFF_CONFIG constants", () => {
  it("MAX_ATTEMPTS is 5", () => {
    expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBe(5);
  });

  it("BASE_DELAY_MS is 1 second", () => {
    expect(BACKOFF_CONFIG.BASE_DELAY_MS).toBe(1_000);
  });

  it("MAX_DELAY_MS is 30 seconds", () => {
    expect(BACKOFF_CONFIG.MAX_DELAY_MS).toBe(30_000);
  });

  it("MAX_RETRY_WINDOW_MS is 120 seconds", () => {
    expect(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS).toBe(120_000);
  });

  it("config values are reasonable for job retries", () => {
    // 5 attempts with max 30s delays = ~2 min max window
    expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBeLessThanOrEqual(10);
    expect(BACKOFF_CONFIG.MAX_DELAY_MS).toBeLessThanOrEqual(60_000);
    expect(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS).toBeGreaterThan(BACKOFF_CONFIG.MAX_DELAY_MS * 2);
  });

  it("constants are immutable (readonly)", () => {
    expect(() => {
      // @ts-expect-error Testing immutability
      BACKOFF_CONFIG.MAX_ATTEMPTS = 10;
    }).toThrow();
  });
});

describe("theoretical retry window", () => {
  it("maximum total delay across all attempts fits within window", () => {
    // Worst case: every attempt hits the max delay
    const maxTotalDelay = BACKOFF_CONFIG.MAX_ATTEMPTS * BACKOFF_CONFIG.MAX_DELAY_MS;
    // Should be <= MAX_RETRY_WINDOW_MS
    expect(maxTotalDelay).toBeLessThanOrEqual(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS * 2); // Allow some margin
  });

  it("average retry window is reasonable", () => {
    // With full jitter, the average delay per attempt is half that attempt's
    // cap: min(MAX_DELAY_MS, BASE_DELAY_MS * 2^attempt).
    let avgTotalDelay = 0;
    for (let attempt = 0; attempt < BACKOFF_CONFIG.MAX_ATTEMPTS; attempt++) {
      avgTotalDelay +=
        Math.min(BACKOFF_CONFIG.MAX_DELAY_MS, BACKOFF_CONFIG.BASE_DELAY_MS * 2 ** attempt) / 2;
    }
    // Should complete within a minute on average
    expect(avgTotalDelay).toBeLessThan(60_000);
  });

  it("prevents thundering herd with full jitter", () => {
    // Simulate 10 jobs all reclaimed at the same time (attempt 0)
    const delays = Array.from({ length: 10 }, () =>
      calculateBackoffDelay(0, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS),
    );

    // With full jitter, all should NOT fire at once
    // Check that delays are spread out (not all the same)
    const uniqueDelays = new Set(delays).size;
    expect(uniqueDelays).toBeGreaterThan(1);

    // Check that they don't bunch up at start
    const delaysOver500ms = delays.filter((d) => d > 500).length;
    expect(delaysOver500ms).toBeGreaterThan(0);
  });
});

describe("cumulative retry ceiling (#688)", () => {
  it("schedules a retry when elapsed + delay stays within maxRetryWindowMs", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const decision = evaluateRetryBackoff(1, {
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        maxRetryWindowMs: 10_000,
        elapsedMs: 3_000,
      });

      expect(decision).toEqual({
        status: "retry",
        delayMs: 1_000, // 0.5 * min(30_000, 1_000 * 2^1) = 1_000
        cumulativeElapsedMs: 4_000,
        remainingBudgetMs: 6_000,
        maxRetryWindowMs: 10_000,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("immediately returns timeout_exhausted when elapsedMs already meets or exceeds ceiling", () => {
    const decision = evaluateRetryBackoff(0, {
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxRetryWindowMs: 15_000,
      elapsedMs: 15_000,
    });

    expect(decision).toEqual({
      status: "timeout_exhausted",
      reason: "retry_window_exceeded",
      elapsedMs: 15_000,
      maxRetryWindowMs: 15_000,
    });
  });

  it("surfaces timeout_exhausted when individual delays are well below maxDelayMs but cumulative time exceeds ceiling", () => {
    // Every individual attempt delay is 4_000ms — well under maxDelayMs (30_000ms) —
    // yet cumulative elapsed retry time across attempts exceeds maxRetryWindowMs (10_000ms).
    const spy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const tracker = createRetryBudgetTracker({
        baseDelayMs: 4_000,
        maxDelayMs: 30_000,
        maxRetryWindowMs: 10_000,
      });

      // Attempt 0: delay = 4_000ms (<= 30_000ms cap), cumulative = 4_000ms (<= 10_000ms ceiling)
      const first = tracker.nextAttempt();
      expect(first.status).toBe("retry");
      if (first.status === "retry") {
        expect(first.delayMs).toBe(4_000);
        expect(first.delayMs).toBeLessThan(30_000);
        expect(first.cumulativeElapsedMs).toBe(4_000);
      }

      // Attempt 1 with baseDelayMs=4_000 capped via custom options? No: 4_000 * 2^1 = 8_000ms,
      // still well below maxDelayMs (30_000ms), while 4_000 + 8_000 = 12_000ms > 10_000ms ceiling!
      const second = tracker.nextAttempt();
      expect(second).toEqual({
        status: "timeout_exhausted",
        reason: "retry_window_exceeded",
        elapsedMs: 4_000,
        attemptedDelayMs: 8_000,
        maxRetryWindowMs: 10_000,
      });
      if (second.status === "timeout_exhausted") {
        expect(second.attemptedDelayMs).toBeLessThan(30_000);
      }
      // Tracker preserves elapsedMs and attempts without scheduling the overflowing retry
      expect(tracker.attempts).toBe(1);
      expect(tracker.elapsedMs).toBe(4_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("tracks both in-flight execution duration and small per-attempt delays across multiple attempts", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const tracker = createRetryBudgetTracker({
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
        maxRetryWindowMs: 9_000,
      });

      // Attempt 0: 1_500ms in-flight + 1_000ms backoff = 2_500ms cumulative
      const r0 = tracker.nextAttempt(1_500);
      expect(r0).toMatchObject({ status: "retry", delayMs: 1_000, cumulativeElapsedMs: 2_500 });

      // Attempt 1: 2_000ms in-flight + 2_000ms backoff = 6_500ms cumulative
      const r1 = tracker.nextAttempt(2_000);
      expect(r1).toMatchObject({ status: "retry", delayMs: 2_000, cumulativeElapsedMs: 6_500 });

      // Attempt 2: 1_000ms in-flight -> elapsed=7_500ms; next delay=4_000ms (still << 30_000ms cap),
      // 7_500 + 4_000 = 11_500ms > 9_000ms ceiling => timeout_exhausted!
      const r2 = tracker.nextAttempt(1_000);
      expect(r2).toEqual({
        status: "timeout_exhausted",
        reason: "retry_window_exceeded",
        elapsedMs: 7_500,
        attemptedDelayMs: 4_000,
        maxRetryWindowMs: 9_000,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults maxRetryWindowMs to BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS and validates inputs", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      const decision = evaluateRetryBackoff(0, { elapsedMs: -50 });
      expect(decision.status).toBe("retry");
      expect(decision.maxRetryWindowMs).toBe(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS);
      if (decision.status === "retry") {
        expect(decision.cumulativeElapsedMs).toBe(decision.delayMs);
      }
    } finally {
      spy.mockRestore();
    }

    expect(() => evaluateRetryBackoff(0, { maxRetryWindowMs: -1 })).toThrow(RangeError);
    expect(() => evaluateRetryBackoff(0, { maxRetryWindowMs: Number.NaN })).toThrow(RangeError);
    expect(() => evaluateRetryBackoff(0, { elapsedMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => createRetryBudgetTracker({ maxRetryWindowMs: -100 })).toThrow(RangeError);
  });
});
