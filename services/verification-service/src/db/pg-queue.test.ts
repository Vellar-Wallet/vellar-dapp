import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createPgBuildJobQueue,
  type PgBuildJobQueue,
} from "./pg-queue";
import type { BuildJob } from "../server";

describe("pg-queue with visibility timeout", () => {
  const sampleJob: BuildJob = {
    recordId: "rec-123",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sourceType: "repo",
    repoUrl: "https://github.com/example/contract",
    commitHash: "abc1234",
    toolchainVersion: "21.0.0",
  };

  it("happy path: worker claims a submitted job and completes it", async () => {
    let mockTime = 1000;
    const queue: PgBuildJobQueue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs: 5000,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);
    expect(await queue.size()).toBe(1);

    const claimed = await queue.claim("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed?.recordId).toBe("rec-123");
    expect(claimed?.claimedBy).toBe("worker-1");
    expect(claimed?.attempts).toBe(1);

    // Job is now in building state
    const jobState = await queue.getJob("rec-123");
    expect(jobState?.status).toBe("building");
    expect(jobState?.claimedBy).toBe("worker-1");

    // Complete the job
    const completed = await queue.complete("rec-123", "worker-1");
    expect(completed).toBe(true);

    const finalState = await queue.getJob("rec-123");
    expect(finalState?.status).toBe("completed");

    // Completed job is no longer active
    expect(await queue.size()).toBe(0);
  });

  it("visibility timeout: crashed worker job is retried by another worker after timeout", async () => {
    let mockTime = 10000;
    const visibilityTimeoutMs = 5000;
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);

    // Worker 1 claims the job at t = 10000
    const claim1 = await queue.claim("worker-1");
    expect(claim1).not.toBeNull();
    expect(claim1?.claimedBy).toBe("worker-1");
    expect(claim1?.attempts).toBe(1);

    // Mid-TTL: t = 12000 (elapsed 2000ms < 5000ms timeout)
    // Worker 1 has crashed, worker 2 attempts to claim
    mockTime = 12000;
    const claimTooEarly = await queue.claim("worker-2");
    expect(claimTooEarly).toBeNull(); // Still visible to worker 1 / locked

    // After visibility timeout: t = 16000 (elapsed 6000ms > 5000ms timeout)
    mockTime = 16000;
    const claim2 = await queue.claim("worker-2");
    expect(claim2).not.toBeNull();
    expect(claim2?.recordId).toBe("rec-123");
    expect(claim2?.claimedBy).toBe("worker-2");
    expect(claim2?.attempts).toBe(2);

    // Worker 2 completes the job
    const completed = await queue.complete("rec-123", "worker-2");
    expect(completed).toBe(true);

    const state = await queue.getJob("rec-123");
    expect(state?.status).toBe("completed");

    // Advance time again; completed job should never be claimed again
    mockTime = 25000;
    const claimAfterComplete = await queue.claim("worker-3");
    expect(claimAfterComplete).toBeNull();
  });

  it("ensures a job is not claimed twice simultaneously by concurrent workers", async () => {
    let mockTime = 5000;
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs: 10000,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);

    // Two workers attempt to claim the same job simultaneously in the same event-loop tick
    const [claimA, claimB] = await Promise.all([
      queue.claim("worker-A"),
      queue.claim("worker-B"),
    ]);

    // Exactly one worker must win the claim; the other must receive null
    const winners = [claimA, claimB].filter(Boolean);
    const losers = [claimA, claimB].filter((c) => c === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.attempts).toBe(1);
  });

  it("handles release of a claimed job back to submitted queue immediately", async () => {
    let mockTime = 1000;
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs: 30000,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);
    const claim1 = await queue.claim("worker-1");
    expect(claim1).not.toBeNull();

    // Worker voluntarily releases job
    await queue.release("rec-123");

    // Another worker can immediately claim it without waiting for visibility timeout
    const claim2 = await queue.claim("worker-2");
    expect(claim2).not.toBeNull();
    expect(claim2?.claimedBy).toBe("worker-2");
  });

  it("rejects a late completion from the original worker after a visibility-timeout reclaim (#794)", async () => {
    let mockTime = 10000;
    const visibilityTimeoutMs = 5000;
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);

    // Worker 1 claims at t=10000. It is slow, not crashed.
    const firstClaim = await queue.claim("worker-1");
    expect(firstClaim?.claimedBy).toBe("worker-1");
    expect(firstClaim?.attempts).toBe(1);

    // The visibility timeout expires and worker 2 legitimately reclaims.
    mockTime += visibilityTimeoutMs + 1;
    const secondClaim = await queue.claim("worker-2");
    expect(secondClaim?.claimedBy).toBe("worker-2");
    expect(secondClaim?.attempts).toBe(2);

    // Worker 1 finishes a moment later. Its stale completion must be rejected
    // rather than letting two workers believe they both own the job.
    expect(await queue.complete("rec-123", "worker-1")).toBe(false);
    const afterStale = await queue.getJob("rec-123");
    expect(afterStale?.status).toBe("building");
    expect(afterStale?.claimedBy).toBe("worker-2");

    // The rightful owner can still complete it, and only once.
    expect(await queue.complete("rec-123", "worker-2")).toBe(true);
    expect(await queue.complete("rec-123", "worker-2")).toBe(false);
    expect((await queue.getJob("rec-123"))?.status).toBe("completed");
    expect(await queue.size()).toBe(0);
  });

  it("allows a completion from a caller that does not supply a worker id", async () => {
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs: 5000,
      now: () => 1000,
    });

    await queue.enqueue(sampleJob);
    await queue.claim("worker-1");

    // Legacy callers omit the optional workerId; fencing must not break them.
    expect(await queue.complete("rec-123")).toBe(true);
    expect((await queue.getJob("rec-123"))?.status).toBe("completed");
  });

  it("Postgres path fences completions with a claimedBy predicate when a worker id is supplied (#794)", async () => {
    const returning = vi.fn(async () => [{ id: "rec-123" }]);
    const where = vi.fn(() => ({ returning }));
    const update = vi.fn(() => ({ set: () => ({ where }) }));
    const db = { update } as unknown as Parameters<typeof createPgBuildJobQueue>[0];
    const queue = createPgBuildJobQueue(db, { now: () => 1000 });

    expect(await queue.complete("rec-123", "stale-worker")).toBe(true);
    const withOwner = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as SQL);
    expect(withOwner.sql).toContain("claimedBy");
    expect(withOwner.params).toContain("stale-worker");
    expect(withOwner.params).toContain("building");

    // Legacy callers that omit the id must not gain a new WHERE condition.
    expect(await queue.complete("rec-123")).toBe(true);
    const withoutOwner = new PgDialect().sqlToQuery(where.mock.calls[1]![0] as SQL);
    expect(withoutOwner.sql).not.toContain("claimedBy");
    expect(withoutOwner.params).toContain("building");
    expect(withoutOwner.params).not.toContain("stale-worker");
  });

  it("dead-letters job if maxAttempts exceeded after repeated timeouts", async () => {
    let mockTime = 1000;
    const visibilityTimeoutMs = 1000;
    const queue = createPgBuildJobQueue(undefined, {
      visibilityTimeoutMs,
      maxAttempts: 2,
      now: () => mockTime,
    });

    await queue.enqueue(sampleJob);

    // Attempt 1
    const c1 = await queue.claim("w1");
    expect(c1?.attempts).toBe(1);

    // Crash, timeout 1
    mockTime += 2000;
    const c2 = await queue.claim("w2");
    expect(c2?.attempts).toBe(2);

    // Crash, timeout 2 (attempts == 2 >= maxAttempts)
    mockTime += 2000;
    const c3 = await queue.claim("w3");
    expect(c3).toBeNull();

    const state = await queue.getJob("rec-123");
    expect(state?.status).toBe("dead_letter");
  });
});
