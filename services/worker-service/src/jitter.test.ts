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
