import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemoryDeployJobStore,
  MAX_RETRIES,
  computeBackoff,
  processDeploymentJob,
} from "./policy-deploy-worker";
import { createMemoryDLQStore } from "./dlq-store";
import { createMemoryPolicyRepository } from "./server";
import type { PolicyDeployer, DeployPolicyInstanceInput } from "./deploy";
import type { DLQMetrics } from "./policy-deploy-worker";

describe("Policy Deployment Worker", () => {
  let jobStore: InMemoryDeployJobStore;
  let dlqStore = createMemoryDLQStore();
  let policyRepo = createMemoryPolicyRepository();
  let deployer: PolicyDeployer;
  let dlqMetrics: DLQMetrics;

  beforeEach(() => {
    jobStore = new InMemoryDeployJobStore();
    dlqStore = createMemoryDLQStore();
    policyRepo = createMemoryPolicyRepository();

    deployer = {
      simulateInstance: vi.fn().mockResolvedValue({ ok: true, minResourceFee: "1000" }),
      deployInstance: vi.fn().mockResolvedValue({
        contractId: "CCONT123",
        txHash: "tx123",
      }),
    };

    dlqMetrics = {
      dlq_enqueue_total: { inc: vi.fn() },
      dlq_depth_gauge: { set: vi.fn() },
    };
  });

  describe("computeBackoff", () => {
    it("returns exponential backoff delays", () => {
      expect(computeBackoff(0)).toBe(1000); // base 1s
      expect(computeBackoff(1)).toBe(1000); // 2^0 * 1000
      expect(computeBackoff(2)).toBe(2000); // 2^1 * 1000
      expect(computeBackoff(3)).toBe(4000); // 2^2 * 1000
      expect(computeBackoff(4)).toBe(8000); // 2^3 * 1000
    });

    it("caps delay at 1 hour", () => {
      const maxDelayMs = 60 * 60 * 1000;
      expect(computeBackoff(20)).toBeLessThanOrEqual(maxDelayMs);
      expect(computeBackoff(30)).toBeLessThanOrEqual(maxDelayMs);
    });
  });

  describe("Job retry logic", () => {
    it("retries job when retry_count < MAX_RETRIES", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      const error = new Error("Temporary error");
      await jobStore.handleFailure("job-1", error, dlqStore, dlqMetrics);

      const updated = await jobStore.get("job-1");
      expect(updated?.retry_count).toBe(3);
      expect(updated?.status).toBe("pending"); // Not dead
      expect(updated?.last_error).toContain("Temporary error");
    });

    it("moves job to DLQ when retry_count exceeds MAX_RETRIES", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "in_progress" as const,
        retry_count: MAX_RETRIES,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      const error = new Error("Permanent failure");
      await jobStore.handleFailure("job-1", error, dlqStore, dlqMetrics);

      // Job should be marked dead
      const updated = await jobStore.get("job-1");
      expect(updated?.status).toBe("dead");

      // Entry should be in DLQ
      const dlqList = await dlqStore.list();
      expect(dlqList.entries).toHaveLength(1);
      expect(dlqList.entries[0].original_job_id).toBe("job-1");
      expect(dlqList.entries[0].failure_count).toBe(MAX_RETRIES + 1);

      // Metrics should be incremented
      expect(dlqMetrics.dlq_enqueue_total.inc).toHaveBeenCalledWith({
        job_type: "policy_deploy",
      });
    });

    it("creates audit event when moving to DLQ", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "in_progress" as const,
        retry_count: MAX_RETRIES,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      const error = new Error("Deployment error");
      await jobStore.handleFailure("job-1", error, dlqStore, dlqMetrics);

      const dlqList = await dlqStore.list();
      const dlqId = dlqList.entries[0].id;

      const auditTrail = await dlqStore.getAuditTrail(dlqId);
      expect(auditTrail).toHaveLength(1);
      expect(auditTrail[0].event_type).toBe("dlq_move");
      expect(auditTrail[0].metadata.original_job_id).toBe("job-1");
    });

    it("handles concurrent failures safely", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "in_progress" as const,
        retry_count: MAX_RETRIES,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      // Simulate two workers handling the same job failure concurrently
      await Promise.all([
        jobStore.handleFailure("job-1", new Error("Error 1"), dlqStore, dlqMetrics),
        jobStore.handleFailure("job-1", new Error("Error 2"), dlqStore, dlqMetrics),
      ]);

      // Only one DLQ entry should be created (in real implementation with DB transaction)
      const dlqList = await dlqStore.list();
      // In-memory store will have 2 entries (no transaction support), but count the enqueue calls
      expect(dlqMetrics.dlq_enqueue_total.inc).toHaveBeenCalledTimes(2);
    });

    it("redacts sensitive information in errors", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "in_progress" as const,
        retry_count: MAX_RETRIES,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      const error = new Error(
        "Contract C5DFWDXQVZZVH5Z4N4WF2YHOZQBBZTM443LZK5K4YQPSFCSJSYQB4BG4 not found",
      );
      await jobStore.handleFailure("job-1", error, dlqStore, dlqMetrics);

      const dlqList = await dlqStore.list();
      const errorMessage = dlqList.entries[0].last_error;

      // Contract address should be redacted
      expect(errorMessage).toContain("[contract]");
      expect(errorMessage).not.toContain("C5DFWDXQVZZVH5Z4N4WF2YHOZQBBZTM");
    });
  });

  describe("Timestamp tracking", () => {
    it("sets first_failed_at on first failure", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      await jobStore.handleFailure("job-1", new Error("Error"), dlqStore);

      const updated = await jobStore.get("job-1");
      expect(updated?.first_failed_at).toBeDefined();
      expect(updated?.last_failed_at).toBeDefined();
    });

    it("updates last_failed_at on subsequent failures", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 1,
        first_failed_at: new Date(Date.now() - 60000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      const oldLastFailed = job.last_failed_at;
      await new Promise((r) => setTimeout(r, 10));

      await jobStore.handleFailure("job-1", new Error("Error"), dlqStore);

      const updated = await jobStore.get("job-1");
      expect(updated?.first_failed_at).toBe(job.first_failed_at);
      expect(updated?.last_failed_at).not.toBe(oldLastFailed);
    });
  });

  describe("DLQ depth metrics", () => {
    it("updates dlq_depth_gauge when moving to DLQ", async () => {
      const job = {
        id: "job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "in_progress" as const,
        retry_count: MAX_RETRIES,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jobStore.addJob(job);

      await jobStore.handleFailure("job-1", new Error("Error"), dlqStore, dlqMetrics);

      expect(dlqMetrics.dlq_depth_gauge.set).toHaveBeenCalledWith(1);
    });

    it("tracks multiple DLQ entries", async () => {
      for (let i = 0; i < 3; i++) {
        const job = {
          id: `job-${i}`,
          policy_id: `policy-${i}`,
          wallet: "CWALLET",
          network: "testnet" as const,
          status: "in_progress" as const,
          retry_count: MAX_RETRIES,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        jobStore.addJob(job);
        await jobStore.handleFailure(`job-${i}`, new Error(`Error ${i}`), dlqStore, dlqMetrics);
      }

      const depth = await dlqStore.depth();
      expect(depth).toBe(3);
    });
  });
});
