import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMemoryJobStore } from "./memory-job-store";
import { calculateBackoffDelay, BACKOFF_CONFIG } from "./backoff";

describe("memory-job-store reaper with exponential backoff", () => {
  describe("backoff callbacks", () => {
    it("calls onReclaimed when a job is reclaimed", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      // Create a job in building state that will be reclaimed
      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      // Claim it (moves to building)
      await store.claimSubmitted(1);
      const row = store.get("r1");
      expect(row?.status).toBe("building");

      // Simulate a stranded job (started building 20 min ago)
      const now = Date.now();
      const strandedSince = now - 20 * 60_000;
      if (row) {
        row.startedBuildingAtMs = strandedSince;
      }

      // Reap it
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(onReclaimed).toHaveBeenCalledWith(0); // attempts - 1 = 1 - 1 = 0
      expect(store.get("r1")?.status).toBe("submitted");
    });

    it("calls onDeadLettered when exhausting max attempts", async () => {
      const store = createMemoryJobStore();
      const onDeadLettered = vi.fn();

      // Create and claim a job multiple times to reach max attempts
      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      // Manually set attempts to 3 (at max)
      const row = store.get("r1");
      if (row) {
        row.attempts = 3;
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
      }

      // Reap it — should dead-letter
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onDeadLettered,
      });

      expect(onDeadLettered).toHaveBeenCalledOnce();
      expect(store.get("r1")?.status).toBe("dead_letter");
    });

    it("passes correct attempt number to onReclaimed callback", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      // Create job and manually set attempts to 2
      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.attempts = 2;
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
      }

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      // attempts=2, so callback gets 2-1=1
      expect(onReclaimed).toHaveBeenCalledWith(1);
    });

    it("calls both onReclaimed and onDeadLettered in one sweep", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();
      const onDeadLettered = vi.fn();

      const now = Date.now();
      const strandedTime = now - 20 * 60_000;

      // Job 1: attempts=1 (will reclaim)
      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });
      const r1 = store.get("r1");
      if (r1) {
        r1.attempts = 1;
        r1.status = "building";
        r1.startedBuildingAtMs = strandedTime;
      }

      // Job 2: attempts=3 (will dead-letter)
      store.submit("r2", {
        contractId: "C2",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });
      const r2 = store.get("r2");
      if (r2) {
        r2.attempts = 3;
        r2.status = "building";
        r2.startedBuildingAtMs = strandedTime;
      }

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
        onDeadLettered,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(onReclaimed).toHaveBeenCalledWith(0); // 1 - 1 = 0
      expect(onDeadLettered).toHaveBeenCalledOnce();
    });
  });

  describe("backoff delay parameters", () => {
    it("accepts baseBackoffDelayMs and maxBackoffDelayMs", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
      }

      // Call with custom backoff parameters
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 500,
        maxBackoffDelayMs: 15_000,
        onReclaimed,
      });

      // Should still reclaim the job
      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(store.get("r1")?.status).toBe("submitted");
    });

    it("uses defaults when backoff parameters not provided", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
      }

      // Call without baseBackoffDelayMs/maxBackoffDelayMs
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      // Should still work with defaults
      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(store.get("r1")?.status).toBe("submitted");
    });
  });

  describe("reaper behavior matches interface contract", () => {
    it("returns correct ReapResult with backoff callbacks", async () => {
      const store = createMemoryJobStore();

      const now = Date.now();
      const strandedTime = now - 20 * 60_000;

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });
      store.submit("r2", {
        contractId: "C2",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const r1 = store.get("r1");
      if (r1) {
        r1.status = "building";
        r1.startedBuildingAtMs = strandedTime;
        r1.attempts = 1;
      }

      const r2 = store.get("r2");
      if (r2) {
        r2.status = "building";
        r2.startedBuildingAtMs = strandedTime;
        r2.attempts = 3;
      }

      const result = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
      });

      expect(result.reclaimed).toBe(1);
      expect(result.deadLettered).toBe(1);
    });

    it("does not call callbacks for jobs within timeout", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();
      const onDeadLettered = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        // Started only 5 min ago (within 15-min timeout)
        row.startedBuildingAtMs = Date.now() - 5 * 60_000;
      }

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
        onDeadLettered,
      });

      expect(onReclaimed).not.toHaveBeenCalled();
      expect(onDeadLettered).not.toHaveBeenCalled();
      expect(store.get("r1")?.status).toBe("building"); // Unchanged
    });
  });

  describe("edge cases with backoff", () => {
    it("handles zero maxAttempts", async () => {
      const store = createMemoryJobStore();
      const onDeadLettered = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
        row.attempts = 0;
      }

      const result = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 0,
        onDeadLettered,
      });

      // attempts=0 >= maxAttempts=0, so should dead-letter
      expect(result.deadLettered).toBe(1);
      expect(onDeadLettered).toHaveBeenCalledOnce();
    });

    it("handles empty store with backoff parameters", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();
      const onDeadLettered = vi.fn();

      const result = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 1000,
        maxBackoffDelayMs: 30_000,
        onReclaimed,
        onDeadLettered,
      });

      expect(result.reclaimed).toBe(0);
      expect(result.deadLettered).toBe(0);
      expect(onReclaimed).not.toHaveBeenCalled();
      expect(onDeadLettered).not.toHaveBeenCalled();
    });

    it("handles nowMs parameter for time control", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const baseTime = 1000_000_000;
      const row = store.get("r1");
      if (row) {
        row.status = "building";
        // Job started at time 1000_000
        row.startedBuildingAtMs = baseTime - 1000;
      }

      // Reap at time baseTime; job has been building for 1s (< 15-min timeout)
      const result = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        nowMs: baseTime,
        onReclaimed,
      });

      expect(result.reclaimed).toBe(0);
      expect(onReclaimed).not.toHaveBeenCalled();

      // Reap at much later time; now timeout is exceeded
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        nowMs: baseTime + 20 * 60_000,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
    });
  });

  describe("backoff calculation integration", () => {
    it("calculates delays internally during reap", async () => {
      const store = createMemoryJobStore();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
        row.attempts = 2;
      }

      // The reap should internally calculate:
      // calculateBackoffDelay(2, 1000, 30000)
      // which should return [0, 4000]
      // But we can only verify it completed successfully
      const result = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: BACKOFF_CONFIG.BASE_DELAY_MS,
        maxBackoffDelayMs: BACKOFF_CONFIG.MAX_DELAY_MS,
      });

      expect(result.reclaimed).toBe(1);
      expect(store.get("r1")?.status).toBe("submitted");
    });

    it("respects BACKOFF_CONFIG in calculations", async () => {
      const store = createMemoryJobStore();
      const onReclaimed = vi.fn();

      store.submit("r1", {
        contractId: "C1",
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "abc1234",
        toolchainVersion: "1.94.0",
      });

      const row = store.get("r1");
      if (row) {
        row.status = "building";
        row.startedBuildingAtMs = Date.now() - 20 * 60_000;
      }

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: BACKOFF_CONFIG.MAX_ATTEMPTS,
        baseBackoffDelayMs: BACKOFF_CONFIG.BASE_DELAY_MS,
        maxBackoffDelayMs: BACKOFF_CONFIG.MAX_DELAY_MS,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
    });
  });
});
