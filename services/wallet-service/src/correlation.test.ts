import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import { runWorkerTick, type WorkerDeps } from "../../worker-service/src/loop";
import type { ClaimedJob, VerificationJobStore } from "../../worker-service/src/job-store";
import type { BuildExecutor } from "../../worker-service/src/executor";
import type { ContractArtifactResolver } from "../../worker-service/src/resolver";

describe("Correlation ID end-to-end propagation (Issue #299)", () => {
  it("preserves correlation ID from wallet-service request to enqueued worker-service job and logs", async () => {
    const enqueuedJobs: ClaimedJob[] = [];
    const logs: string[] = [];

    // Mock job store shared between wallet enqueue and worker loop
    const jobQueue = {
      async enqueue(job: {
        recordId: string;
        contractId: string;
        correlationId?: string;
        [key: string]: unknown;
      }) {
        enqueuedJobs.push({
          recordId: job.recordId,
          contractId: job.contractId,
          correlationId: job.correlationId,
          sourceType: "repo",
          toolchainVersion: "latest",
        });
      },
    };

    const submitter = { submit: vi.fn(async () => ({ hash: "txhash123" })) };
    const walletApp = buildServer({
      submitter,
      jobQueue,
    });

    const testCorrelationId = "corr-test-xyz-98765";

    // 1. Submit job to wallet-service with x-correlation-id header
    const res = await walletApp.inject({
      method: "POST",
      url: "/wallet/jobs",
      headers: {
        "x-correlation-id": testCorrelationId,
      },
      payload: {
        recordId: "rec-001",
        contractId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers["x-correlation-id"]).toBe(testCorrelationId);
    expect(res.json().correlationId).toBe(testCorrelationId);

    // Verify job in queue has the correlation ID
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]?.correlationId).toBe(testCorrelationId);

    // 2. Process the job with worker-service loop
    const completedRecordIds: string[] = [];
    const mockStore: VerificationJobStore = {
      async claimSubmitted(_limit: number) {
        return [...enqueuedJobs];
      },
      async complete(recordId: string) {
        completedRecordIds.push(recordId);
      },
      async reapStranded() {
        return { reclaimed: 0, deadLettered: 0 };
      },
      async countActive() {
        return enqueuedJobs.length;
      },
      async hasActiveForContract() {
        return false;
      },
      async listLatestVerified() {
        return [];
      },
    };

    const mockExecutor: BuildExecutor = {
      async build() {
        return { wasmHash: "hash123", log: "built successfully" };
      },
    };

    const mockResolver: ContractArtifactResolver = {
      async resolveDeployedHash() {
        return "hash123";
      },
    };

    const workerLog = {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
    };

    const workerDeps: WorkerDeps = {
      store: mockStore,
      executor: mockExecutor,
      resolver: mockResolver,
      log: workerLog,
    };

    const processedCount = await runWorkerTick(workerDeps);
    expect(processedCount).toBe(1);
    expect(completedRecordIds).toContain("rec-001");

    // 3. Verify correlation ID is preserved in worker log entries
    const matchingLog = logs.find((l) => l.includes(testCorrelationId));
    expect(matchingLog).toBeDefined();
    expect(matchingLog).toContain(`[correlationId=${testCorrelationId}]`);

    await walletApp.close();
  });
});
