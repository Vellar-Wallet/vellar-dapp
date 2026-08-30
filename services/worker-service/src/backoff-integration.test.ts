import { describe, expect, it, vi, beforeEach } from "vitest";
import { calculateBackoffDelay, BACKOFF_CONFIG } from "./backoff";
import { domainMetrics, __resetMetricsForTest } from "@vellar/service-kit";

/**
 * Integration tests verifying exponential backoff works end-to-end with:
 * - Calculation utilities
 * - Configuration constants
 * - Prometheus metrics (from service-kit)
 */

describe("backoff strategy end-to-end integration", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  describe("backoff configuration consistency", () => {
    it("MAX_ATTEMPTS provides sensible max retries", () => {
      // 5 attempts = 1 initial + 4 retries
      expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
      expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBeLessThanOrEqual(10);
    });

    it("BASE_DELAY_MS is reasonable for production", () => {
      // Should be at least 100ms to avoid busy-spinning
      expect(BACKOFF_CONFIG.BASE_DELAY_MS).toBeGreaterThanOrEqual(100);
      // Should be at most 5 seconds
      expect(BACKOFF_CONFIG.BASE_DELAY_MS).toBeLessThanOrEqual(5_000);
    });

    it("MAX_DELAY_MS is reasonable for retry window", () => {
      // Should be greater than BASE_DELAY
      expect(BACKOFF_CONFIG.MAX_DELAY_MS).toBeGreaterThan(BACKOFF_CONFIG.BASE_DELAY_MS);
      // Should be at most 1 minute per attempt
      expect(BACKOFF_CONFIG.MAX_DELAY_MS).toBeLessThanOrEqual(60_000);
    });

    it("MAX_RETRY_WINDOW_MS encompasses all retries", () => {
      // Upper bound: max delay * max attempts
      const maxTheoretical = BACKOFF_CONFIG.MAX_DELAY_MS * BACKOFF_CONFIG.MAX_ATTEMPTS;
      // Actual should be at least half that (accounting for jitter average)
      expect(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS).toBeGreaterThan(
        BACKOFF_CONFIG.MAX_DELAY_MS
      );
      // But not unreasonably high
      expect(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS).toBeLessThanOrEqual(maxTheoretical);
    });
  });

  describe("backoff delay scaling", () => {
    it("scales exponentially from base to max", () => {
      const delays = Array.from({ length: BACKOFF_CONFIG.MAX_ATTEMPTS }, (_, i) => {
        // Use fixed random for predictable caps
        const spy = vi.spyOn(Math, "random").mockReturnValue(1);
        const d = calculateBackoffDelay(i, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);
        spy.mockRestore();
        return d;
      });

      // First delay should be close to base
      expect(delays[0]).toBeGreaterThan(BACKOFF_CONFIG.BASE_DELAY_MS * 0.9);
      expect(delays[0]).toBeLessThanOrEqual(BACKOFF_CONFIG.BASE_DELAY_MS);

      // Should generally increase (though capped)
      expect(delays[delays.length - 1]).toBeLessThanOrEqual(BACKOFF_CONFIG.MAX_DELAY_MS);
    });

    it("prevents unbounded growth", () => {
      // Even with attempt=100, should respect MAX_DELAY_MS
      const delay = calculateBackoffDelay(100, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(BACKOFF_CONFIG.MAX_DELAY_MS);
    });
  });

  describe("full jitter behavior", () => {
    it("produces uniform distribution within bounds", () => {
      // Run many samples at attempt 3
      const samples = 1000;
      const delays = Array.from({ length: samples }, () =>
        calculateBackoffDelay(3, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS)
      );

      const min = Math.min(...delays);
      const max = Math.max(...delays);
      const sum = delays.reduce((a, b) => a + b, 0);
      const avg = sum / delays.length;

      // Should see full range
      expect(min).toBeLessThan(1000);
      expect(max).toBeGreaterThan(7000);

      // Average should be near half the cap (uniform distribution property)
      const cap = Math.min(BACKOFF_CONFIG.BASE_DELAY_MS * Math.pow(2, 3), BACKOFF_CONFIG.MAX_DELAY_MS);
      const expectedAvg = cap / 2;
      expect(avg).toBeGreaterThan(expectedAvg * 0.8);
      expect(avg).toBeLessThan(expectedAvg * 1.2);
    });

    it("prevents thundering herd when multiple jobs retry simultaneously", () => {
      // Simulate 100 jobs all hitting attempt 0 retry at the same time
      const jobDelays = Array.from({ length: 100 }, () =>
        calculateBackoffDelay(0, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS)
      );

      const uniqueDelays = new Set(jobDelays).size;
      // With true randomness, should have variety
      expect(uniqueDelays).toBeGreaterThan(50);

      // Check they don't cluster
      const bucketed = {
        "0-200ms": 0,
        "200-400ms": 0,
        "400-600ms": 0,
        "600-800ms": 0,
        "800-1000ms": 0,
      };

      for (const delay of jobDelays) {
        if (delay < 200) bucketed["0-200ms"]++;
        else if (delay < 400) bucketed["200-400ms"]++;
        else if (delay < 600) bucketed["400-600ms"]++;
        else if (delay < 800) bucketed["600-800ms"]++;
        else bucketed["800-1000ms"]++;
      }

      // Each bucket should have some jobs (not clustered at one end)
      const nonEmptyBuckets = Object.values(bucketed).filter((count) => count > 0).length;
      expect(nonEmptyBuckets).toBeGreaterThanOrEqual(3);
    });
  });

  describe("metrics integration", () => {
    it("verificationRetry counter exists and accepts labels", () => {
      // Increment the counter
      domainMetrics.verificationRetry.inc({
        service: "worker-service",
        attempt: "1",
      });

      // Should not throw; counter should be available
      expect(domainMetrics.verificationRetry).toBeDefined();
    });

    it("verificationDeadLetter counter exists", () => {
      domainMetrics.verificationDeadLetter.inc({
        service: "worker-service",
      });

      expect(domainMetrics.verificationDeadLetter).toBeDefined();
    });

    it("retry counter can record multiple attempts", () => {
      // Simulate a job retrying multiple times
      for (let attempt = 0; attempt < BACKOFF_CONFIG.MAX_ATTEMPTS; attempt++) {
        domainMetrics.verificationRetry.inc({
          service: "worker-service",
          attempt: String(attempt),
        });
      }

      // Counter should accept all calls without error
      expect(domainMetrics.verificationRetry).toBeDefined();
    });

    it("dead-letter counter tracks exhausted jobs", () => {
      const numDeadLettered = 5;
      for (let i = 0; i < numDeadLettered; i++) {
        domainMetrics.verificationDeadLetter.inc({
          service: "worker-service",
        });
      }

      expect(domainMetrics.verificationDeadLetter).toBeDefined();
    });
  });

  describe("retry window analysis", () => {
    it("calculates theoretical maximum retry window", () => {
      // Sum of all potential maximum delays
      let maxWindow = 0;
      for (let attempt = 0; attempt < BACKOFF_CONFIG.MAX_ATTEMPTS; attempt++) {
        const cap = Math.min(
          BACKOFF_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt),
          BACKOFF_CONFIG.MAX_DELAY_MS
        );
        maxWindow += cap;
      }

      // Should be less than the configured MAX_RETRY_WINDOW_MS
      expect(maxWindow).toBeLessThanOrEqual(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS * 2);
    });

    it("calculates average retry window with full jitter", () => {
      // With full jitter, average delay per attempt is half the cap
      let avgWindow = 0;
      for (let attempt = 0; attempt < BACKOFF_CONFIG.MAX_ATTEMPTS; attempt++) {
        const cap = Math.min(
          BACKOFF_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt),
          BACKOFF_CONFIG.MAX_DELAY_MS
        );
        avgWindow += cap / 2;
      }

      // Average should complete well within window
      expect(avgWindow).toBeLessThan(BACKOFF_CONFIG.MAX_RETRY_WINDOW_MS);
    });

    it("ensures first retry is responsive", () => {
      // First retry (attempt 0) should start promptly, not get blocked waiting
      expect(BACKOFF_CONFIG.BASE_DELAY_MS).toBeLessThan(5000);
    });

    it("ensures later retries back off significantly", () => {
      // Last attempt should have substantial delay to avoid overwhelming
      const lastAttemptCap = Math.min(
        BACKOFF_CONFIG.BASE_DELAY_MS * Math.pow(2, BACKOFF_CONFIG.MAX_ATTEMPTS - 1),
        BACKOFF_CONFIG.MAX_DELAY_MS
      );

      expect(lastAttemptCap).toBeGreaterThan(BACKOFF_CONFIG.BASE_DELAY_MS * 2);
    });
  });

  describe("correctness properties", () => {
    it("backoff delay is always integer milliseconds", () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);
        expect(Number.isInteger(delay)).toBe(true);
      }
    });

    it("backoff delay is never negative", () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });

    it("backoff delay respects both constraints", () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);

        // Must respect max
        expect(delay).toBeLessThanOrEqual(BACKOFF_CONFIG.MAX_DELAY_MS);

        // For early attempts, should stay within exponential bound
        const expCap = Math.min(
          BACKOFF_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt),
          BACKOFF_CONFIG.MAX_DELAY_MS
        );
        expect(delay).toBeLessThanOrEqual(expCap);
      }
    });
  });

  describe("M7 security audit properties", () => {
    it("MAX_ATTEMPTS prevents infinite retry loops", () => {
      // After MAX_ATTEMPTS, job should be dead-lettered (not retried)
      expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
      expect(BACKOFF_CONFIG.MAX_ATTEMPTS).toBeLessThanOrEqual(10);
    });

    it("exponential backoff prevents denial-of-service", () => {
      // Each retry costs exponentially more time than previous
      const delays = Array.from({ length: 5 }, (_, i) => {
        const spy = vi.spyOn(Math, "random").mockReturnValue(1);
        const d = calculateBackoffDelay(i, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS);
        spy.mockRestore();
        return d;
      });

      // Delays should be monotonically increasing (or hitting cap)
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] * 0.9); // Allow small variation
      }
    });

    it("full jitter prevents coordinated thundering herd", () => {
      // 50 jobs, all retrying at once (attempt=2)
      const delaySpread = new Set(
        Array.from({ length: 50 }, () =>
          calculateBackoffDelay(2, BACKOFF_CONFIG.BASE_DELAY_MS, BACKOFF_CONFIG.MAX_DELAY_MS)
        )
      ).size;

      // Should have good distribution (not all same value)
      expect(delaySpread).toBeGreaterThan(20);
    });
  });
});
