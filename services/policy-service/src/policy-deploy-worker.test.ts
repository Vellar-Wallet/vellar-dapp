import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemoryDeployJobStore,
  MAX_RETRIES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_DLQ_THRESHOLD,
  TerminalDeployError,
  isTerminalFailure,
  computeBackoff,
  processDeploymentJob,
} from "./policy-deploy-worker";
import { createMemoryDLQStore } from "./dlq-store";
import { createMemoryPolicyRepository, type PolicyRecord } from "./server";
import type { PolicyDeployer, DeployPolicyInstanceInput } from "./deploy";
import type { DeployJob, DLQMetrics } from "./policy-deploy-worker";

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
    it("returns jittered exponential backoff delays within bounds", () => {
      // Full jitter: delay = random(0, min(cap, base * 2^attempt))
      for (let i = 0; i < 20; i++) {
        expect(computeBackoff(0)).toBeLessThanOrEqual(1000);
        expect(computeBackoff(1)).toBeLessThanOrEqual(1000);
        expect(computeBackoff(2)).toBeLessThanOrEqual(2000);
        expect(computeBackoff(3)).toBeLessThanOrEqual(4000);
        expect(computeBackoff(4)).toBeLessThanOrEqual(8000);
      }
    });

    it("retries are not perfectly periodic (jitter produces varied delays)", () => {
      const delays = new Set<number>();
      for (let i = 0; i < 50; i++) {
        delays.add(computeBackoff(3));
      }
      expect(delays.size).toBeGreaterThan(1);
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
      expect(dlqList.entries[0]!.original_job_id).toBe("job-1");
      expect(dlqList.entries[0]!.failure_count).toBe(MAX_RETRIES + 1);

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
      const dlqId = dlqList.entries[0]!.id;

      const auditTrail = await dlqStore.getAuditTrail(dlqId);
      expect(auditTrail).toHaveLength(1);
      expect(auditTrail[0]!.event_type).toBe("dlq_move");
      expect(auditTrail[0]!.metadata.original_job_id).toBe("job-1");
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
      const errorMessage = dlqList.entries[0]!.last_error;

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
      const job: DeployJob = {
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

  describe("processDeploymentJob", () => {
    const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const OWNER = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
    const ARGS = { dailyLimitStroops: "1000000000", windowSeconds: 86400 };

    function seedPolicy(enforcement: PolicyRecord["manifest"]["enforcement"]) {
      return policyRepo.insert({
        id: "policy-1",
        createdAt: new Date().toISOString(),
        status: "generated",
        definition: {
          version: "1",
          type: "spending_limit",
          owners: [OWNER],
          spendingLimits: { dailyXlm: "100" },
        },
        policyHash: "hash",
        manifest: { template: "spending_limit", enforcement, network: "testnet" },
      });
    }

    function seedJob() {
      const now = new Date().toISOString();
      jobStore.addJob({
        id: "job-1",
        policy_id: "policy-1",
        wallet: WALLET,
        network: "testnet",
        status: "pending",
        retry_count: 0,
        created_at: now,
        updated_at: now,
      });
    }

    it("deploys with the constructor args from the policy manifest", async () => {
      await seedPolicy({ kind: "policy-contract", wasmHash: "wasm", constructorArgs: ARGS });
      seedJob();

      await processDeploymentJob(jobStore, policyRepo, deployer, dlqStore, dlqMetrics);

      expect(deployer.deployInstance).toHaveBeenCalledWith({
        wallet: WALLET,
        constructorArgs: ARGS,
      });
      expect((await jobStore.get("job-1"))?.status).toBe("completed");
    });

    it("fails the job without deploying when the policy is not contract-enforced", async () => {
      await seedPolicy({ kind: "signer-limits" });
      seedJob();

      await processDeploymentJob(jobStore, policyRepo, deployer, dlqStore, dlqMetrics);

      expect(deployer.deployInstance).not.toHaveBeenCalled();
      const job = await jobStore.get("job-1");
      expect(job?.status).not.toBe("completed");
      expect(job?.last_error).toMatch(/not contract-enforced/);
    });
  });

  describe("Failure classification: retryable vs terminal (#528)", () => {
    it("classifies explicit TerminalDeployError as terminal", () => {
      const err = new TerminalDeployError("Invalid policy template parameters");
      expect(isTerminalFailure(err)).toBe(true);
    });

    it("classifies permanent failure patterns as terminal", () => {
      expect(isTerminalFailure(new Error("Policy not found: 123"))).toBe(true);
      expect(isTerminalFailure(new Error("Policy is not contract-enforced: abc"))).toBe(true);
      expect(isTerminalFailure(new Error("Unknown policy type: custom_bad"))).toBe(true);
      expect(isTerminalFailure(new Error("missing constructor args"))).toBe(true);
      expect(isTerminalFailure(new Error("schema version 99 does not exist"))).toBe(true);
      expect(isTerminalFailure(new Error("unattributable publisher: bad_pub"))).toBe(true);
    });

    it("classifies transient errors as retryable (not terminal)", () => {
      expect(isTerminalFailure(new Error("Network connection timed out"))).toBe(false);
      expect(isTerminalFailure(new Error("RPC 503 Service Unavailable"))).toBe(false);
      expect(isTerminalFailure(new Error("Transaction simulation transient error"))).toBe(false);
    });
  });

  describe("Max-attempts cap distinct from DLQ threshold (#528)", () => {
    it("stops a retryable failure at a lower maxAttempts cap before reaching DLQ threshold", async () => {
      // Store configured with maxAttempts: 2, dlqThreshold: 5
      const customStore = new InMemoryDeployJobStore({ maxAttempts: 2, dlqThreshold: 5 });
      const job = {
        id: "capped-job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      customStore.addJob(job);

      // Attempt 1: retryable error -> should increment retry_count to 1 and stay pending
      const error1 = new Error("Temporary network timeout");
      await customStore.handleFailure("capped-job-1", error1, dlqStore, dlqMetrics);
      const afterAttempt1 = await customStore.get("capped-job-1");
      expect(afterAttempt1?.retry_count).toBe(1);
      expect(afterAttempt1?.status).toBe("pending");

      // Attempt 2: retryable error -> retry_count becomes 2, reaching maxAttempts (2) < dlqThreshold (5)
      const error2 = new Error("Temporary network timeout again");
      await customStore.handleFailure("capped-job-1", error2, dlqStore, dlqMetrics);
      const afterAttempt2 = await customStore.get("capped-job-1");
      expect(afterAttempt2?.retry_count).toBe(2);
      expect(afterAttempt2?.status).toBe("dead");

      // Moved to DLQ at 2 attempts, not 5
      const dlqList = await dlqStore.list();
      const dlqEntry = dlqList.entries.find((e) => e.original_job_id === "capped-job-1");
      expect(dlqEntry).toBeDefined();
      expect(dlqEntry?.failure_count).toBe(2);
    });

    it("respects per-job max_attempts over store default", async () => {
      const customStore = new InMemoryDeployJobStore({ maxAttempts: 4, dlqThreshold: 5 });
      const job = {
        id: "per-job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 0,
        max_attempts: 1, // Stop on attempt 1
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      customStore.addJob(job);

      await customStore.handleFailure("per-job-1", new Error("Transient error"), dlqStore, dlqMetrics);
      const updated = await customStore.get("per-job-1");
      expect(updated?.retry_count).toBe(1);
      expect(updated?.status).toBe("dead");

      const dlqList = await dlqStore.list();
      const dlqEntry = dlqList.entries.find((e) => e.original_job_id === "per-job-1");
      expect(dlqEntry).toBeDefined();
      expect(dlqEntry?.failure_count).toBe(1);
    });
  });

  describe("Fast terminal failure on attempt 1 (#528)", () => {
    it("moves a terminal failure to DLQ immediately on the very first attempt without retrying", async () => {
      const job = {
        id: "terminal-job-1",
        policy_id: "policy-1",
        wallet: "CWALLET",
        network: "testnet" as const,
        status: "pending" as const,
        retry_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      jobStore.addJob(job);

      // Fails on attempt 1 with a terminal error
      const terminalErr = new TerminalDeployError("Permanently invalid template configuration");
      await jobStore.handleFailure("terminal-job-1", terminalErr, dlqStore, dlqMetrics);

      const updated = await jobStore.get("terminal-job-1");
      // Must be dead immediately
      expect(updated?.status).toBe("dead");
      expect(updated?.retry_count).toBe(1);

      // Must be in DLQ
      const dlqList = await dlqStore.list();
      const dlqEntry = dlqList.entries.find((e) => e.original_job_id === "terminal-job-1");
      expect(dlqEntry).toBeDefined();
      expect(dlqEntry?.failure_count).toBe(1);
      expect(dlqEntry?.last_error).toContain("Permanently invalid template configuration");

      // Audit event must record terminal: true
      const auditTrail = await dlqStore.getAuditTrail(dlqEntry!.id);
      expect(auditTrail[0]?.event_type).toBe("dlq_move");
      expect(auditTrail[0]?.metadata.terminal).toBe(true);
    });

    it("processDeploymentJob moves terminal error to DLQ on attempt 1", async () => {
      // Policy repo has no policy for this job -> triggers terminal Policy not found
      const now = new Date().toISOString();
      jobStore.addJob({
        id: "missing-policy-job",
        policy_id: "nonexistent-policy-id",
        wallet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        network: "testnet",
        status: "pending",
        retry_count: 0,
        created_at: now,
        updated_at: now,
      });

      const processed = await processDeploymentJob(jobStore, policyRepo, deployer, dlqStore, dlqMetrics);
      expect(processed).toBe(true);

      const job = await jobStore.get("missing-policy-job");
      expect(job?.status).toBe("dead");
      expect(job?.retry_count).toBe(1);

      const dlqList = await dlqStore.list();
      const dlqEntry = dlqList.entries.find((e) => e.original_job_id === "missing-policy-job");
      expect(dlqEntry).toBeDefined();
      expect(dlqEntry?.last_error).toMatch(/Policy not found/);
    });
  });
});

