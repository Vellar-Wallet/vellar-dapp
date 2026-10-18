import { describe, expect, it } from "vitest";
import { createMemoryVerificationRepository, type BuildJob } from "../server";
import { createPgBuildJobQueue, DEFAULT_VISIBILITY_TIMEOUT_MS } from "./pg-queue";

const CONTRACT_ID = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

const sampleJob: BuildJob = {
  recordId: "rec-visibility-1",
  contractId: CONTRACT_ID,
  sourceType: "repo",
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
  buildFlags: ["--release"],
};

describe("PgBuildJobQueue visibility timeout (#535)", () => {
  it("defaults visibilityTimeoutMs to DEFAULT_VISIBILITY_TIMEOUT_MS and rejects non-positive timeouts", () => {
    const queue = createPgBuildJobQueue();
    expect(queue.visibilityTimeoutMs).toBe(DEFAULT_VISIBILITY_TIMEOUT_MS);

    expect(() => createPgBuildJobQueue({ visibilityTimeoutMs: 0 })).toThrow(/visibilityTimeoutMs/);
    expect(() => createPgBuildJobQueue({ visibilityTimeoutMs: -500 })).toThrow(
      /visibilityTimeoutMs/,
    );
  });

  it("prevents simultaneous double-claim within the active visibility window", async () => {
    let clock = 1_700_000_000_000;
    const queue = createPgBuildJobQueue({
      visibilityTimeoutMs: 60_000,
      now: () => clock,
    });

    await queue.enqueue(sampleJob);

    const firstClaim = await queue.claimNext("worker-1");
    expect(firstClaim).toEqual({
      job: sampleJob,
      workerId: "worker-1",
      claimedAtMs: 1_700_000_000_000,
      visibleAfterMs: 1_700_000_060_000,
      attempts: 1,
    });

    // Advance clock partway through the visibility window (59.999s < 60s)
    clock += 59_999;
    const concurrentClaim = await queue.claimNext("worker-2");
    expect(concurrentClaim).toBeUndefined();
  });

  it("allows a second worker to reclaim and complete a job after the first worker crashes and the visibility timeout expires", async () => {
    let clock = 1_700_000_000_000;
    const records = createMemoryVerificationRepository();
    await records.insert({
      id: sampleJob.recordId,
      contractId: sampleJob.contractId,
      sourceType: sampleJob.sourceType,
      repoUrl: sampleJob.repoUrl,
      commitHash: sampleJob.commitHash,
      toolchainVersion: sampleJob.toolchainVersion,
      status: "submitted",
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
    });

    const queue = createPgBuildJobQueue({
      visibilityTimeoutMs: 30_000,
      now: () => clock,
      records,
    });

    await queue.enqueue(sampleJob);

    // 1. Worker 1 claims the job and then crashes before calling complete()
    const claim1 = await queue.claimNext("worker-1");
    expect(claim1?.workerId).toBe("worker-1");
    expect(claim1?.attempts).toBe(1);
    expect((await records.find(sampleJob.recordId))?.status).toBe("building");

    // 2. While within the 30s visibility window, Worker 2 cannot claim it
    clock += 15_000;
    expect(await queue.claimNext("worker-2")).toBeUndefined();

    // 3. Visibility timeout expires at +30s; Worker 2 claims the stranded job
    clock += 15_000;
    const claim2 = await queue.claimNext("worker-2");
    expect(claim2).toEqual({
      job: sampleJob,
      workerId: "worker-2",
      claimedAtMs: 1_700_000_030_000,
      visibleAfterMs: 1_700_000_060_000,
      attempts: 2,
    });

    // Stale completion from crashed worker-1 is fenced off
    expect(await queue.complete(sampleJob.recordId, "verified", "worker-1")).toBe(false);

    // 4. Worker 2 completes the job
    expect(await queue.complete(sampleJob.recordId, "verified", "worker-2")).toBe(true);
    expect((await records.find(sampleJob.recordId))?.status).toBe("verified");

    // 5. Even after another visibility window passes, completed job is never reclaimed
    clock += 60_000;
    expect(await queue.claimNext("worker-3")).toBeUndefined();
  });
});
