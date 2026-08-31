import { describe, expect, it, vi } from "vitest";
import { MaxRetriesExceededError, RetryAbortedError, retryWithBackoff } from "./retry";

// Zero-delay sleep so tests don't actually wait.
const fastSleep = async (_ms: number) => {};

// ─── Basic behaviour ─────────────────────────────────────────────────────────

describe("retryWithBackoff — basic behaviour", () => {
  it("resolves immediately when fn succeeds on the first attempt", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await retryWithBackoff(fn, { sleep: fastSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries and resolves after an initial failure", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls < 2) throw new Error("transient");
      return "recovered";
    });
    const result = await retryWithBackoff(fn, { sleep: fastSleep });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws MaxRetriesExceededError after exhausting all attempts", async () => {
    const err = new Error("always fails");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, sleep: fastSleep }),
    ).rejects.toBeInstanceOf(MaxRetriesExceededError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("MaxRetriesExceededError.cause is the last thrown error", async () => {
    const lastErr = new Error("last");
    let call = 0;
    const fn = vi.fn(async () => {
      throw call++ === 0 ? new Error("first") : lastErr;
    });
    const caught = await retryWithBackoff(fn, { maxAttempts: 2, sleep: fastSleep }).catch(
      (e) => e,
    );
    expect(caught).toBeInstanceOf(MaxRetriesExceededError);
    expect((caught as MaxRetriesExceededError).cause).toBe(lastErr);
  });

  it("makes exactly 1 attempt when maxAttempts is 1 (no retries)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fail");
    });
    const caught = await retryWithBackoff(fn, { maxAttempts: 1, sleep: fastSleep }).catch(
      (e) => e,
    );
    expect(caught).toBeInstanceOf(MaxRetriesExceededError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately for maxAttempts < 1", async () => {
    await expect(retryWithBackoff(async () => {}, { maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts must be/,
    );
  });
});

// ─── isRetryable predicate ────────────────────────────────────────────────────

describe("retryWithBackoff — isRetryable predicate", () => {
  it("surfaces a non-retryable error immediately without further attempts", async () => {
    class PermError extends Error {}
    const fn = vi.fn(async () => {
      throw new PermError("permanent");
    });
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 5,
        isRetryable: (e) => !(e instanceof PermError),
        sleep: fastSleep,
      }),
    ).rejects.toBeInstanceOf(PermError);
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it("continues to retry when isRetryable returns true", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls < 3) throw new Error("transient");
      return "done";
    });
    const result = await retryWithBackoff(fn, {
      maxAttempts: 5,
      isRetryable: () => true,
      sleep: fastSleep,
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ─── Backoff timing ───────────────────────────────────────────────────────────

describe("retryWithBackoff — backoff delays", () => {
  it("sleeps with increasing delays (no-jitter mode) between attempts", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const fn = vi.fn(async () => {
      throw new Error("fail");
    });

    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      noJitter: true,
      sleep,
    }).catch(() => {});

    // 3 sleeps for 4 attempts: 100ms, 200ms, 400ms (base * 2^0, 2^1, 2^2)
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
  });

  it("caps delay at maxDelayMs (no-jitter mode)", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("fail");
    });
    await retryWithBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      noJitter: true,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});

    // Caps at 2000ms — never exceeds it.
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(2000);
    }
    // 4th attempt (index 3): base * 2^3 = 8000 → capped to 2000
    expect(delays[3]).toBe(2000);
  });

  it("jitter keeps delay in [0, cap] range", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("fail");
    });
    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      noJitter: false, // default
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});

    const caps = [100, 200, 400];
    for (let i = 0; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(0);
      expect(delays[i]).toBeLessThanOrEqual(caps[i]!);
    }
  });

  it("sleeps N-1 times for N attempts (no sleep after the final attempt)", async () => {
    let sleepCount = 0;
    const fn = vi.fn(async () => {
      throw new Error("fail");
    });
    await retryWithBackoff(fn, {
      maxAttempts: 5,
      sleep: async () => {
        sleepCount++;
      },
    }).catch(() => {});
    expect(sleepCount).toBe(4); // 5 attempts → 4 sleeps
  });
});

// ─── AbortSignal cancellation ─────────────────────────────────────────────────

describe("retryWithBackoff — AbortSignal cancellation", () => {
  it("throws RetryAbortedError when the signal is already aborted before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "should not run");
    await expect(
      retryWithBackoff(fn, { signal: controller.signal, sleep: fastSleep }),
    ).rejects.toBeInstanceOf(RetryAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws RetryAbortedError when the signal fires between attempts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls === 1) {
        // Abort mid-retry cycle.
        controller.abort();
        throw new Error("transient");
      }
      return "should not reach";
    });

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        signal: controller.signal,
        sleep: fastSleep,
      }),
    ).rejects.toBeInstanceOf(RetryAbortedError);
    // fn was called once; the second attempt was blocked by abort.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("retryWithBackoff — edge cases", () => {
  it("uses the default maxAttempts (4) when none is provided", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always");
    });
    await retryWithBackoff(fn, { sleep: fastSleep }).catch(() => {});
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("MaxRetriesExceededError message includes the attempt count", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const err = await retryWithBackoff(fn, { maxAttempts: 2, sleep: fastSleep }).catch((e) => e);
    expect(err.message).toMatch(/2 attempt/);
  });

  it("works with a synchronous-style function wrapped in async", async () => {
    let n = 0;
    const result = await retryWithBackoff(
      async () => {
        n++;
        if (n < 3) throw new Error("not yet");
        return n;
      },
      { sleep: fastSleep },
    );
    expect(result).toBe(3);
  });
});
