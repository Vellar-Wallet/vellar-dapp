import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  createRelayerSubmitter,
  SubmissionError,
  type PasskeyServerLike,
} from "./relayer";

// A passkey-signed request reaches the relayer while the relayer is rotating
// its own signing/auth key. From the wallet-service side that is a transient
// condition: retry with backoff, give up after a bounded number of attempts,
// and never mutate the request or its credentials between attempts.

const SIGNED_XDR = "AAAA-signed-by-the-passkey";
const ROTATING = {
  success: false as const,
  error: {
    code: "key_rotation_in_progress",
    message: "relayer is rotating its signing key",
  },
};

function serverFrom(responses: Array<"rotating" | "throw-401" | { hash: string }>) {
  let call = 0;
  const send = vi.fn(async (_xdr: string) => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next === "rotating") return ROTATING;
    if (next === "throw-401") throw new Error("401 unauthorized: auth key rotated");
    return { success: true as const, hash: (next as { hash: string }).hash };
  });
  const server: PasskeyServerLike = { send };
  return { server, send };
}

const instantSleep = () => vi.fn(async (_ms: number) => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("relayer mid key rotation", () => {
  it("resolves with the hash once the rotation finishes (retryable, not a permanent failure)", async () => {
    const { server, send } = serverFrom(["rotating", "rotating", { hash: "tx-hash-1" }]);
    const sleepFn = instantSleep();

    const result = await createRelayerSubmitter(server, { maxRetries: 3, sleepFn }).submit(
      SIGNED_XDR,
    );

    expect(result).toEqual({ hash: "tx-hash-1" });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("resubmits the identical signed payload on every attempt", async () => {
    const { server, send } = serverFrom(["rotating", "rotating", { hash: "tx-hash-2" }]);

    await createRelayerSubmitter(server, { maxRetries: 3, sleepFn: instantSleep() }).submit(
      SIGNED_XDR,
    );

    expect(send.mock.calls.map(([xdr]) => xdr)).toEqual([SIGNED_XDR, SIGNED_XDR, SIGNED_XDR]);
  });

  it("also retries when the rotation surfaces as a thrown auth error", async () => {
    const { server, send } = serverFrom(["throw-401", { hash: "tx-hash-3" }]);

    const result = await createRelayerSubmitter(server, {
      maxRetries: 2,
      sleepFn: instantSleep(),
    }).submit(SIGNED_XDR);

    expect(result.hash).toBe("tx-hash-3");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts when the rotation never completes", async () => {
    const { server, send } = serverFrom(["rotating"]);

    const attempt = createRelayerSubmitter(server, {
      maxRetries: 3,
      sleepFn: instantSleep(),
      // Keep the breaker out of the way: this case is about the retry bound.
      circuitBreaker: new CircuitBreaker({ failureThreshold: 100 }),
    }).submit(SIGNED_XDR);

    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    // 1 initial attempt + 3 retries, not an unbounded loop.
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("surfaces the relayer's own code on the final failure so callers can tell it from a hard auth failure", async () => {
    const { server } = serverFrom(["rotating"]);

    const attempt = createRelayerSubmitter(server, {
      maxRetries: 1,
      sleepFn: instantSleep(),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 100 }),
    }).submit(SIGNED_XDR);

    await expect(attempt).rejects.toMatchObject({ code: "key_rotation_in_progress" });
  });

  it("backs off between attempts with a capped, growing delay", async () => {
    const { server } = serverFrom(["rotating"]);
    const sleepFn = instantSleep();

    await createRelayerSubmitter(server, {
      maxRetries: 4,
      initialDelayMs: 100,
      maxDelayMs: 300,
      backoffFactor: 2,
      sleepFn,
      circuitBreaker: new CircuitBreaker({ failureThreshold: 100 }),
    })
      .submit(SIGNED_XDR)
      .catch(() => undefined);

    const delays = sleepFn.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(4);
    // Base delays 100, 200, 300 (capped), 300 (capped); jitter adds up to +50%.
    const base = [100, 200, 300, 300];
    delays.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(base[i]!);
      expect(ms).toBeLessThanOrEqual(Math.floor(base[i]! * 1.5));
    });
  });

  it("does not sleep after the final attempt", async () => {
    const { server } = serverFrom(["rotating"]);
    const sleepFn = instantSleep();

    await createRelayerSubmitter(server, {
      maxRetries: 2,
      sleepFn,
      circuitBreaker: new CircuitBreaker({ failureThreshold: 100 }),
    })
      .submit(SIGNED_XDR)
      .catch(() => undefined);

    expect(sleepFn).toHaveBeenCalledTimes(2);
  });
});

describe("circuit breaker during a long key rotation", () => {
  it("stops hammering the relayer once the failure threshold is reached", async () => {
    const { server, send } = serverFrom(["rotating"]);
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });
    const submitter = createRelayerSubmitter(server, {
      maxRetries: 5,
      sleepFn: instantSleep(),
      circuitBreaker: breaker,
    });

    await expect(submitter.submit(SIGNED_XDR)).rejects.toBeInstanceOf(SubmissionError);

    // The breaker opened after 3 failures, cutting the retry loop short.
    expect(breaker.getState()).toBe("OPEN");
    expect(send).toHaveBeenCalledTimes(3);

    // While open, new requests fail fast without touching the relayer.
    await expect(submitter.submit(SIGNED_XDR)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("lets a trial request through after the reset timeout and closes once the relayer recovers", async () => {
    const { server, send } = serverFrom(["rotating", "rotating", { hash: "tx-after-rotation" }]);
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1_000 });
    const submitter = createRelayerSubmitter(server, {
      maxRetries: 0,
      sleepFn: instantSleep(),
      circuitBreaker: breaker,
    });

    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow);

    await expect(submitter.submit(SIGNED_XDR)).rejects.toBeInstanceOf(SubmissionError);
    await expect(submitter.submit(SIGNED_XDR)).rejects.toBeInstanceOf(SubmissionError);
    expect(breaker.getState()).toBe("OPEN");

    // Rotation finishes and the reset timeout elapses.
    now.mockReturnValue(realNow + 1_001);
    const result = await submitter.submit(SIGNED_XDR);

    expect(result).toEqual({ hash: "tx-after-rotation" });
    expect(breaker.getState()).toBe("CLOSED");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("resets the failure count after a success so earlier rotation failures do not accumulate", async () => {
    const { server } = serverFrom(["rotating", { hash: "ok" }]);
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    await createRelayerSubmitter(server, {
      maxRetries: 2,
      sleepFn: instantSleep(),
      circuitBreaker: breaker,
    }).submit(SIGNED_XDR);

    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe("CLOSED");
  });
});
