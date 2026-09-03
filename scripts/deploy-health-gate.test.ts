import { describe, expect, it, vi } from "vitest";
import { runHealthGate } from "./deploy-health-gate";

/** A fake fetch returning a fixed sequence of responses/errors, one per call. */
function scriptedFetch(sequence: Array<{ ok: boolean; status: number } | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const next = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (!next) throw new Error("scriptedFetch: empty sequence");
    if (next instanceof Error) throw next;
    return { ok: next.ok, status: next.status } as Response;
  });
}

/** Deterministic clock: advances by `intervalMs` on every sleep call. */
function fakeClock(intervalMs: number) {
  let current = 0;
  const now = () => current;
  const sleep = async (ms: number) => {
    current += ms;
  };
  return { now, sleep, advanceOnFetch: () => {} };
}

describe("runHealthGate", () => {
  it("succeeds immediately when already healthy for the required consecutive count", async () => {
    const clock = fakeClock(1000);
    const result = await runHealthGate({
      url: "http://x/health",
      consecutive: 3,
      intervalMs: 1000,
      timeoutMs: 60_000,
      fetchImpl: scriptedFetch([
        { ok: true, status: 200 },
        { ok: true, status: 200 },
        { ok: true, status: 200 },
      ]),
      now: clock.now,
      sleepImpl: clock.sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.at(2)?.consecutiveHealthy).toBe(3);
  });

  it("resets the consecutive counter on a single unhealthy response, not aborting the whole gate", async () => {
    const clock = fakeClock(1000);
    const result = await runHealthGate({
      url: "http://x/health",
      consecutive: 2,
      intervalMs: 1000,
      timeoutMs: 60_000,
      fetchImpl: scriptedFetch([
        { ok: true, status: 200 },
        { ok: false, status: 503 }, // resets the streak
        { ok: true, status: 200 },
        { ok: true, status: 200 },
      ]),
      now: clock.now,
      sleepImpl: clock.sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(4);
    expect(result.attempts.map((a) => a.consecutiveHealthy)).toEqual([1, 0, 1, 2]);
  });

  it("treats a network error (fetch throwing) as unhealthy, not a crash", async () => {
    const clock = fakeClock(1000);
    const result = await runHealthGate({
      url: "http://x/health",
      consecutive: 1,
      intervalMs: 1000,
      timeoutMs: 60_000,
      fetchImpl: scriptedFetch([new Error("ECONNREFUSED"), { ok: true, status: 200 }]),
      now: clock.now,
      sleepImpl: clock.sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts.at(0)?.healthy).toBe(false);
    expect(result.attempts.at(0)?.error).toBe("ECONNREFUSED");
    expect(result.attempts.at(1)?.healthy).toBe(true);
  });

  it("times out and returns ok: false if the required streak is never reached", async () => {
    const clock = fakeClock(1000);
    const result = await runHealthGate({
      url: "http://x/health",
      consecutive: 3,
      intervalMs: 1000,
      timeoutMs: 3_000, // only ~3 attempts fit
      fetchImpl: scriptedFetch([{ ok: false, status: 503 }]), // never healthy
      now: clock.now,
      sleepImpl: clock.sleep,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.attempts.every((a) => !a.healthy)).toBe(true);
  });

  it("calls onAttempt for every poll", async () => {
    const clock = fakeClock(1000);
    const onAttempt = vi.fn();
    await runHealthGate({
      url: "http://x/health",
      consecutive: 2,
      intervalMs: 1000,
      timeoutMs: 60_000,
      fetchImpl: scriptedFetch([{ ok: true, status: 200 }, { ok: true, status: 200 }]),
      now: clock.now,
      sleepImpl: clock.sleep,
      onAttempt,
    });

    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it("defaults consecutive to 3 when unspecified", async () => {
    const clock = fakeClock(1000);
    const result = await runHealthGate({
      url: "http://x/health",
      intervalMs: 1000,
      timeoutMs: 60_000,
      fetchImpl: scriptedFetch([
        { ok: true, status: 200 },
        { ok: true, status: 200 },
        { ok: true, status: 200 },
      ]),
      now: clock.now,
      sleepImpl: clock.sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(3);
  });
});
