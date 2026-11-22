import { describe, expect, it } from "vitest";
import { jitteredDelayMs } from "./jitter";

describe("jitteredDelayMs (issue #331)", () => {
  it("returns exactly baseMs when random() is 0.5 (the midpoint — zero offset)", () => {
    expect(jitteredDelayMs(300_000, 30_000, { random: () => 0.5 })).toBe(300_000);
  });

  it("returns baseMs - boundMs when random() is 0 (the minimum offset)", () => {
    expect(jitteredDelayMs(300_000, 30_000, { random: () => 0 })).toBe(270_000);
  });

  it("returns baseMs + boundMs when random() approaches 1 (the maximum offset)", () => {
    // random() is conventionally [0, 1) — 1 itself never actually occurs, but
    // the formula should still land exactly on the upper bound at the limit.
    expect(jitteredDelayMs(300_000, 30_000, { random: () => 1 })).toBe(330_000);
  });

  it("never returns a value outside [baseMs - boundMs, baseMs + boundMs]", () => {
    for (let i = 0; i <= 20; i++) {
      const r = i / 20;
      const result = jitteredDelayMs(300_000, 30_000, { random: () => r });
      expect(result).toBeGreaterThanOrEqual(270_000);
      expect(result).toBeLessThanOrEqual(330_000);
    }
  });

  it("clamps to minMs so a large negative offset can't produce a non-positive delay", () => {
    // boundMs (30_000) larger than baseMs (10_000) would otherwise go negative.
    expect(jitteredDelayMs(10_000, 30_000, { random: () => 0, minMs: 1000 })).toBe(1000);
  });

  it("defaults minMs to 0 when not supplied", () => {
    expect(jitteredDelayMs(10_000, 30_000, { random: () => 0 })).toBe(0);
  });

  it("boundMs of 0 disables jitter entirely — always returns exactly baseMs", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(jitteredDelayMs(300_000, 0, { random: () => r })).toBe(300_000);
    }
  });

  it("produces a genuinely distributed spread across repeated real calls (not a fixed value)", () => {
    // Uses the real Math.random default (no injected random) — this is the
    // production code path, not just the deterministic-fixture tests above.
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(jitteredDelayMs(300_000, 30_000));
    }
    // Vanishingly unlikely to collide 50 times with real randomness unless
    // jitter isn't actually being applied.
    expect(results.size).toBeGreaterThan(1);
    for (const value of results) {
      expect(value).toBeGreaterThanOrEqual(270_000);
      expect(value).toBeLessThanOrEqual(330_000);
    }
  });
});

describe("jitteredDelayMs — 10,000-sample statistical bounds (issue #796)", () => {
  const SAMPLES = 10_000;

  it("keeps all 10,000 real-random samples inside the documented bounds without bias", () => {
    const baseMs = 300_000;
    const boundMs = 30_000;
    const lower = baseMs - boundMs;
    const upper = baseMs + boundMs;

    let sum = 0;
    let belowBase = 0;
    let atOrAboveBase = 0;
    let reachedLowerTail = false;
    let reachedUpperTail = false;

    for (let i = 0; i < SAMPLES; i++) {
      // No injected random: exercise the production Math.random path.
      const value = jitteredDelayMs(baseMs, boundMs);
      expect(value).toBeGreaterThanOrEqual(lower);
      expect(value).toBeLessThanOrEqual(upper);

      sum += value;
      if (value < baseMs) belowBase++;
      else atOrAboveBase++;
      if (value <= lower + boundMs / 10) reachedLowerTail = true;
      if (value >= upper - boundMs / 10) reachedUpperTail = true;
    }

    // A one-sided offset (e.g. random() * 2 with the -1 omitted) would move the
    // mean by ~30s; 1s is roughly 6 standard errors at this sample size.
    expect(Math.abs(sum / SAMPLES - baseMs)).toBeLessThan(1_000);
    // Uniform jitter should split almost evenly around the base.
    expect(belowBase).toBeGreaterThan(SAMPLES * 0.4);
    expect(belowBase).toBeLessThan(SAMPLES * 0.6);
    expect(atOrAboveBase).toBeGreaterThan(SAMPLES * 0.4);
    expect(atOrAboveBase).toBeLessThan(SAMPLES * 0.6);
    // Both tails must actually be exercised, not just the middle of the range.
    expect(reachedLowerTail).toBe(true);
    expect(reachedUpperTail).toBe(true);
  });

  it("clamps all 10,000 samples to minMs without ever exceeding the upper bound", () => {
    const baseMs = 10_000;
    const boundMs = 10_000;
    const minMs = baseMs;

    let clamped = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const value = jitteredDelayMs(baseMs, boundMs, { minMs });
      expect(value).toBeGreaterThanOrEqual(minMs);
      expect(value).toBeLessThanOrEqual(baseMs + boundMs);
      if (value === minMs) clamped++;
    }

    // baseMs + offset only clears minMs when random() >= 0.5, so about half
    // the samples must land exactly on the clamp.
    expect(clamped).toBeGreaterThan(SAMPLES * 0.4);
    expect(clamped).toBeLessThan(SAMPLES * 0.6);
  });
});
