import { describe, expect, it, vi } from "vitest";
import {
  circuitBreakerLimitsFromEnv,
  CircuitOpenError,
  createCircuitBreaker,
} from "./circuit-breaker";

function fakeClock(startAt = 0) {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createCircuitBreaker — closed state", () => {
  it("starts closed and runs calls normally", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    expect(breaker.state).toBe("closed");
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("stays closed after fewer consecutive failures than the threshold", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    const failing = () => Promise.reject(new Error("downstream 500"));

    await expect(breaker.execute(failing)).rejects.toThrow("downstream 500");
    await expect(breaker.execute(failing)).rejects.toThrow("downstream 500");
    expect(breaker.state).toBe("closed"); // 2 failures, threshold is 3
  });

  it("an intermittent success resets the consecutive-failure count", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    const failing = () => Promise.reject(new Error("downstream 500"));

    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok"); // resets counter
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    // 2 failures again since the reset — still under the threshold of 3.
    expect(breaker.state).toBe("closed");
  });
});

describe("createCircuitBreaker — opening", () => {
  it("opens exactly when consecutive failures reach the threshold", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    const failing = () => Promise.reject(new Error("downstream 500"));

    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe("closed");
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe("closed");
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe("open"); // 3rd consecutive failure trips it
  });

  it("fast-fails with CircuitOpenError once open — the wrapped fn is never called again", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const fn = vi.fn(() => Promise.reject(new Error("downstream 500")));

    await expect(breaker.execute(fn)).rejects.toThrow("downstream 500");
    expect(breaker.state).toBe("open");

    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(1); // NOT called again — fast-fail, no network attempt
  });

  it("CircuitOpenError reports the remaining cooldown", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    await expect(breaker.execute(() => Promise.reject(new Error("x")))).rejects.toThrow();

    clock.advance(4_000);
    const err = await breaker.execute(() => Promise.reject(new Error("unreachable"))).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).retryAfterMs).toBe(6_000);
  });
});

describe("createCircuitBreaker — half-open transition and resolution", () => {
  it("allows exactly one trial call after the cooldown elapses", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    await expect(breaker.execute(() => Promise.reject(new Error("x")))).rejects.toThrow();
    expect(breaker.state).toBe("open");

    clock.advance(10_000);
    const fn = vi.fn(async () => "recovered");
    await expect(breaker.execute(fn)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe("closed"); // trial succeeded — fully closed again
  });

  it("a failing trial call re-opens the breaker with a fresh cooldown", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    await expect(breaker.execute(() => Promise.reject(new Error("x")))).rejects.toThrow();

    clock.advance(10_000); // cooldown elapsed
    await expect(breaker.execute(() => Promise.reject(new Error("still down")))).rejects.toThrow(
      "still down",
    );
    expect(breaker.state).toBe("open");

    // Immediately after the failed trial, the ORIGINAL cooldown has not
    // magically re-elapsed — the fresh window starts from the trial's
    // failure time, not the original open time.
    const err = await breaker.execute(() => Promise.reject(new Error("unreachable"))).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });

  it("does not allow a trial call before the cooldown has elapsed", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    await expect(breaker.execute(() => Promise.reject(new Error("x")))).rejects.toThrow();

    clock.advance(9_999); // one ms short
    const fn = vi.fn(async () => "should not run");
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("createCircuitBreaker — beforeCall/recordOutcome (hook-based callers, e.g. @fastify/http-proxy)", () => {
  it("beforeCall throws CircuitOpenError when open, without needing a wrapped promise", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000, now: clock.now });
    breaker.recordOutcome("failure");
    expect(breaker.state).toBe("open");

    expect(() => breaker.beforeCall()).toThrow(CircuitOpenError);
  });

  it("beforeCall allows the half-open trial through after cooldown, matching execute's behavior", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000, now: clock.now });
    breaker.recordOutcome("failure");
    clock.advance(5_000);

    expect(() => breaker.beforeCall()).not.toThrow();
    expect(breaker.state).toBe("half_open");
  });

  it("recordOutcome drives the exact same state machine execute uses internally", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });
    breaker.beforeCall();
    breaker.recordOutcome("failure");
    expect(breaker.state).toBe("closed");
    breaker.beforeCall();
    breaker.recordOutcome("failure");
    expect(breaker.state).toBe("open");
  });
});

describe("createCircuitBreaker — onStateChange metric hook (#326)", () => {
  it("fires exactly once per real transition, not on every call", async () => {
    const clock = fakeClock();
    const transitions: Array<[string, string]> = [];
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
      now: clock.now,
      onStateChange: (from, to) => transitions.push([from, to]),
    });
    const failing = () => Promise.reject(new Error("x"));

    await expect(breaker.execute(failing)).rejects.toThrow(); // 1st failure — still closed, no transition
    expect(transitions).toEqual([]);

    await expect(breaker.execute(failing)).rejects.toThrow(); // 2nd — trips open
    expect(transitions).toEqual([["closed", "open"]]);

    clock.advance(1_000);
    await expect(breaker.execute(failing)).rejects.toThrow(); // trial fails — re-opens (closed->open would be wrong; it's open->half_open->open)
    expect(transitions).toEqual([
      ["closed", "open"],
      ["open", "half_open"],
      ["half_open", "open"],
    ]);
  });

  it("covers the full closed -> open -> half_open -> closed cycle", async () => {
    const clock = fakeClock();
    const transitions: Array<[string, string]> = [];
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
      now: clock.now,
      onStateChange: (from, to) => transitions.push([from, to]),
    });

    await expect(breaker.execute(() => Promise.reject(new Error("x")))).rejects.toThrow();
    clock.advance(500);
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");

    expect(transitions).toEqual([
      ["closed", "open"],
      ["open", "half_open"],
      ["half_open", "closed"],
    ]);
  });
});

describe("circuitBreakerLimitsFromEnv", () => {
  it("uses defaults when env vars are unset", () => {
    const limits = circuitBreakerLimitsFromEnv(
      { failureThresholdVar: "CB_FAIL_THRESHOLD", cooldownMsVar: "CB_COOLDOWN_MS" },
      { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
      {},
    );
    expect(limits).toEqual({ failureThreshold: 5, cooldownMs: 30_000 });
  });

  it("reads configured values from env", () => {
    const limits = circuitBreakerLimitsFromEnv(
      { failureThresholdVar: "CB_FAIL_THRESHOLD", cooldownMsVar: "CB_COOLDOWN_MS" },
      { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
      { CB_FAIL_THRESHOLD: "10", CB_COOLDOWN_MS: "5000" },
    );
    expect(limits).toEqual({ failureThreshold: 10, cooldownMs: 5_000 });
  });

  it("falls back to defaults for an invalid (non-positive, non-numeric) env value", () => {
    const limits = circuitBreakerLimitsFromEnv(
      { failureThresholdVar: "CB_FAIL_THRESHOLD", cooldownMsVar: "CB_COOLDOWN_MS" },
      { defaultFailureThreshold: 5, defaultCooldownMs: 30_000 },
      { CB_FAIL_THRESHOLD: "-1", CB_COOLDOWN_MS: "not-a-number" },
    );
    expect(limits).toEqual({ failureThreshold: 5, cooldownMs: 30_000 });
  });
});
