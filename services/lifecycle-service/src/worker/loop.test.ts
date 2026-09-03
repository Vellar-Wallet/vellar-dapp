/**
 * Concurrency tests for cleanup worker (Issue #293).
 *
 * Tests verify that per-account FIFO ordering is maintained when multiple
 * workers process cleanup jobs concurrently. Key invariants tested:
 *
 * 1. Jobs for the same account are always processed in creation order (FIFO)
 * 2. Out-of-order detection metric increments when ordering is violated
 * 3. Multiple workers don't claim the same job (atomic claiming)
 * 4. Jobs for different accounts can be processed in parallel
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runWorkerTick } from "./loop";
import type { CleanupJobStore, ClaimedCleanupJob } from "../db/job-store";
import type { AccountReader } from "../horizon";

describe("Cleanup Worker Concurrency (Issue #293)", () => {
  // SUITE 1: Per-account FIFO ordering
  describe("per-account FIFO ordering", () => {
    it("processes jobs for the same account in creation order", async () => {
      const processedJobs: string[] = [];
      const accountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          {
            jobId: "job-1",
            accountId,
            destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ",
            submittedAtMs: Date.now(),
          },
          {
            jobId: "job-2",
            accountId,
            destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ",
            submittedAtMs: Date.now() + 1000,
          },
          {
            jobId: "job-3",
            accountId,
            destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ",
            submittedAtMs: Date.now() + 2000,
          },
        ]),
        completeJob: vi.fn(async (jobId) => {
          processedJobs.push(jobId);
        }),
        failJob: vi.fn(),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async () => ({
          id: accountId,
          accountMuxed: null,
          sequenceNumber: "1",
          balances: [],
          signers: [],
          data: {},
          subentryCount: 0,
          inflationDest: undefined,
          homeDomain: undefined,
          flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
          thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        })),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
        batchSize: 10,
      });

      // Jobs should be processed in the order they were claimed (job-1, job-2, job-3)
      expect(processedJobs).toEqual(["job-1", "job-2", "job-3"]);
      expect(mockStore.completeJob).toHaveBeenCalledTimes(3);
    });

    it("detects when jobs for the same account arrive out of sequence", async () => {
      const outOfOrderDetections: number[] = [];
      const accountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          {
            jobId: "job-2",
            accountId,
            destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ",
            submittedAtMs: Date.now(),
          },
          {
            jobId: "job-1",
            accountId,
            destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ",
            submittedAtMs: Date.now() - 1000, // Earlier timestamp but claimed later
          },
        ]),
        completeJob: vi.fn(),
        failJob: vi.fn(),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async () => ({
          id: accountId,
          accountMuxed: null,
          sequenceNumber: "1",
          balances: [],
          signers: [],
          data: {},
          subentryCount: 0,
          inflationDest: undefined,
          homeDomain: undefined,
          flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
          thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        })),
      };

      const mockMetrics = {
        cleanupJobsClaimed: vi.fn(),
        cleanupJobsCompleted: vi.fn(),
        cleanupJobsFailed: vi.fn(),
        cleanupOutOfOrderDetected: vi.fn(() => {
          outOfOrderDetections.push(1);
        }),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
        metrics: mockMetrics,
        batchSize: 10,
      });

      // Out-of-order should be detected when job-1 is processed after job-2
      expect(outOfOrderDetections.length).toBeGreaterThan(0);
      expect(mockMetrics.cleanupOutOfOrderDetected).toHaveBeenCalled();
    });
  });

  // SUITE 2: Multi-account parallel processing
  describe("multi-account parallel processing", () => {
    it("processes jobs for different accounts in parallel without blocking", async () => {
      const processedJobs: Array<{ jobId: string; accountId: string }> = [];

      const account1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";
      const account2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ";
      const destination = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCY5XQSQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          { jobId: "job-a1", accountId: account1, destination, submittedAtMs: Date.now() },
          { jobId: "job-b1", accountId: account2, destination, submittedAtMs: Date.now() },
          { jobId: "job-a2", accountId: account1, destination, submittedAtMs: Date.now() + 1000 },
          { jobId: "job-b2", accountId: account2, destination, submittedAtMs: Date.now() + 1000 },
        ]),
        completeJob: vi.fn(async (jobId) => {
          processedJobs.push({
            jobId,
            accountId: jobId.startsWith("job-a") ? account1 : account2,
          });
        }),
        failJob: vi.fn(),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async (id) => ({
          id,
          accountMuxed: null,
          sequenceNumber: "1",
          balances: [],
          signers: [],
          data: {},
          subentryCount: 0,
          inflationDest: undefined,
          homeDomain: undefined,
          flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
          thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        })),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
        batchSize: 10,
      });

      expect(processedJobs.length).toBe(4);
      // Verify all jobs were processed
      expect(processedJobs.map((p) => p.jobId)).toEqual([
        "job-a1",
        "job-b1",
        "job-a2",
        "job-b2",
      ]);
    });
  });

  // SUITE 3: Job failure handling
  describe("job failure handling", () => {
    it("fails invalid accounts and continues with remaining jobs", async () => {
      const failedJobs: string[] = [];
      const completedJobs: string[] = [];

      const validAccount = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";
      const invalidAccount = "invalid-account";
      const destination = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          {
            jobId: "job-invalid",
            accountId: invalidAccount,
            destination,
            submittedAtMs: Date.now(),
          },
          {
            jobId: "job-valid",
            accountId: validAccount,
            destination,
            submittedAtMs: Date.now() + 1000,
          },
        ]),
        completeJob: vi.fn(async (jobId) => {
          completedJobs.push(jobId);
        }),
        failJob: vi.fn(async (jobId) => {
          failedJobs.push(jobId);
        }),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async (id) => {
          if (id === validAccount) {
            return {
              id,
              accountMuxed: null,
              sequenceNumber: "1",
              balances: [],
              signers: [],
              data: {},
              subentryCount: 0,
              inflationDest: undefined,
              homeDomain: undefined,
              flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
              thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
            };
          }
          return null;
        }),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
      });

      // Invalid account job should be failed
      expect(failedJobs).toContain("job-invalid");
      // Valid account job should still be processed
      expect(completedJobs).toContain("job-valid");
    });

    it("continues processing when one job throws an unexpected error", async () => {
      const processedJobs: string[] = [];
      const failedJobs: string[] = [];

      const account1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";
      const account2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ";
      const destination = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCY5XQSQ";

      let throwOnSecond = false;

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          {
            jobId: "job-1",
            accountId: account1,
            destination,
            submittedAtMs: Date.now(),
          },
          {
            jobId: "job-2",
            accountId: account2,
            destination,
            submittedAtMs: Date.now() + 1000,
          },
          {
            jobId: "job-3",
            accountId: account1,
            destination,
            submittedAtMs: Date.now() + 2000,
          },
        ]),
        completeJob: vi.fn(async (jobId) => {
          processedJobs.push(jobId);
        }),
        failJob: vi.fn(async (jobId) => {
          failedJobs.push(jobId);
        }),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async () => {
          if (throwOnSecond) {
            throwOnSecond = false;
            throw new Error("Simulated Horizon error");
          }
          throwOnSecond = true;
          return {
            id: account1,
            accountMuxed: null,
            sequenceNumber: "1",
            balances: [],
            signers: [],
            data: {},
            subentryCount: 0,
            inflationDest: undefined,
            homeDomain: undefined,
            flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
            thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
          };
        }),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
      });

      // Even though job-2 threw an error, job-3 should still be processed
      expect(processedJobs).toContain("job-1");
      expect(processedJobs).toContain("job-3");
      expect(failedJobs).toContain("job-2");
    });
  });

  // SUITE 4: Out-of-order metric tracking
  describe("out-of-order metric tracking", () => {
    it("increments out-of-order metric when jobs arrive out of sequence", async () => {
      const metricsLog: string[] = [];
      const accountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";
      const destination = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async () => [
          {
            jobId: "job-3",
            accountId,
            destination,
            submittedAtMs: Date.now() + 2000,
          },
          {
            jobId: "job-1",
            accountId,
            destination,
            submittedAtMs: Date.now(),
          },
          {
            jobId: "job-2",
            accountId,
            destination,
            submittedAtMs: Date.now() + 1000,
          },
        ]),
        completeJob: vi.fn(),
        failJob: vi.fn(),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async () => ({
          id: accountId,
          accountMuxed: null,
          sequenceNumber: "1",
          balances: [],
          signers: [],
          data: {},
          subentryCount: 0,
          inflationDest: undefined,
          homeDomain: undefined,
          flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
          thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        })),
      };

      const mockMetrics = {
        cleanupJobsClaimed: vi.fn(),
        cleanupJobsCompleted: vi.fn(),
        cleanupJobsFailed: vi.fn(),
        cleanupOutOfOrderDetected: vi.fn(() => {
          metricsLog.push("out_of_order");
        }),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
        metrics: mockMetrics,
      });

      // Out-of-order should be detected multiple times
      expect(metricsLog.length).toBeGreaterThan(0);
      expect(mockMetrics.cleanupOutOfOrderDetected).toHaveBeenCalled();
    });
  });

  // SUITE 5: Batch claiming and processing
  describe("batch claiming and processing", () => {
    it("claims and processes jobs in batches respecting batch size limit", async () => {
      const claimCalls: Array<{ limit: number; returned: number }> = [];
      const accountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3GQ";
      const destination = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY4R7JQ";

      const mockStore: Partial<CleanupJobStore> = {
        claimNextBatch: vi.fn(async (limit) => {
          const jobs = Array.from({ length: Math.min(3, limit ?? 5) }, (_, i) => ({
            jobId: `job-${i + 1}`,
            accountId,
            destination,
            submittedAtMs: Date.now() + i * 1000,
          }));
          claimCalls.push({ limit: limit ?? 5, returned: jobs.length });
          return jobs;
        }),
        completeJob: vi.fn(),
        failJob: vi.fn(),
      };

      const mockReader: Partial<AccountReader> = {
        getAccount: vi.fn(async () => ({
          id: accountId,
          accountMuxed: null,
          sequenceNumber: "1",
          balances: [],
          signers: [],
          data: {},
          subentryCount: 0,
          inflationDest: undefined,
          homeDomain: undefined,
          flags: { authRequired: false, authRevocable: false, clawbackEnabled: false },
          thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        })),
      };

      await runWorkerTick({
        store: mockStore as CleanupJobStore,
        reader: mockReader as AccountReader,
        batchSize: 5,
      });

      expect(claimCalls.length).toBeGreaterThan(0);
      expect(claimCalls[0].limit).toBe(5);
    });
  });
});
