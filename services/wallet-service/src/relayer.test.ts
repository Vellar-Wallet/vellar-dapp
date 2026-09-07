import { describe, expect, it, vi } from "vitest";
import {
  calculateBackoffWithJitter,
  CircuitBreaker,
  CircuitBreakerOpenError,
  createRelayerSubmitter,
  createUnconfiguredSubmitter,
  SubmissionError,
  type PasskeyServerLike,
} from "./relayer";

describe("createRelayerSubmitter", () => {
  it("resolves with the hash on success", async () => {
    const server: PasskeyServerLike = {
      send: async () => ({ success: true, hash: "abc123" }),
    };
    await expect(createRelayerSubmitter(server, { maxRetries: 0 }).submit("xdr")).resolves.toEqual({
      hash: "abc123",
    });
  });

  it("throws SubmissionError with the relayer's code and message on failure", async () => {
    const server: PasskeyServerLike = {
      send: async () => ({
        success: false,
        error: { code: "insufficient_fee", message: "fee too low" },
      }),
    };
    const attempt = createRelayerSubmitter(server, { maxRetries: 0 }).submit("xdr");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "insufficient_fee" });
  });

  it("propagates transport errors from send()", async () => {
    const server: PasskeyServerLike = {
      send: async () => {
        throw new Error("network down");
      },
    };
    await expect(createRelayerSubmitter(server, { maxRetries: 0 }).submit("xdr")).rejects.toThrow(
      "network down",
    );
  });

  it("retries up to maxRetries on failure with backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const sleepFn = async (ms: number) => {
      delays.push(ms);
    };

    const server: PasskeyServerLike = {
      send: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("RPC temporary glitch");
        }
        return { success: true, hash: "retry_success_hash" };
      },
    };

    const submitter = createRelayerSubmitter(server, {
      maxRetries: 3,
      initialDelayMs: 50,
      maxDelayMs: 1000,
      sleepFn,
    });

    const res = await submitter.submit("xdr");
    expect(attempts).toBe(3);
    expect(res.hash).toBe("retry_success_hash");
    expect(delays.length).toBe(2);
  });

  it("trips circuit breaker during sustained RPC failures and decreases retry rate", async () => {
    let callCount = 0;
    const server: PasskeyServerLike = {
      send: async () => {
        callCount++;
        throw new Error("Sustained RPC outage");
      },
    };

    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000 });
    const submitter = createRelayerSubmitter(server, {
      maxRetries: 2,
      circuitBreaker: cb,
      sleepFn: async () => {},
    });

    // First attempt fails (count 3 calls because maxRetries=2)
    await expect(submitter.submit("xdr")).rejects.toThrow("Sustained RPC outage");
    expect(callCount).toBe(3);
    expect(cb.getState()).toBe("OPEN");

    // Subsequent call immediately rejects with CircuitBreakerOpenError without hitting server
    const callCountBefore = callCount;
    await expect(submitter.submit("xdr")).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(callCount).toBe(callCountBefore);
  });

  it("calculates exponential backoff with jitter correctly", () => {
    const delay0 = calculateBackoffWithJitter(0, 100, 2000, 2);
    expect(delay0).toBeGreaterThanOrEqual(100);
    expect(delay0).toBeLessThanOrEqual(150);

    const delay1 = calculateBackoffWithJitter(1, 100, 2000, 2);
    expect(delay1).toBeGreaterThanOrEqual(200);
    expect(delay1).toBeLessThanOrEqual(300);
  });
});

describe("createUnconfiguredSubmitter", () => {
  it("always rejects with relayer_not_configured", async () => {
    const attempt = createUnconfiguredSubmitter().submit("xdr");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "relayer_not_configured" });
  });
});

