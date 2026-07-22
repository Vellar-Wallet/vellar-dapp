import { describe, expect, it, vi } from "vitest";
import { stubBuildExecutor, type BuildExecutor } from "./executor";
import { createStaticArtifactResolver } from "./resolver";
import { createMemoryJobStore } from "./memory-job-store";
import { runWorkerTick, type WorkerMetrics } from "./loop";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const job = (contractId: string) => ({
  contractId,
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
  buildFlags: ["--release"],
});

describe("runWorkerTick", () => {
  it("claims a submitted job, builds, and marks it verified on a match", async () => {
    const executor = stubBuildExecutor();
    const built = await executor.build(job(C1));
    const resolver = createStaticArtifactResolver({ [C1]: built.wasmHash });

    const store = createMemoryJobStore();
    store.submit("r1", job(C1));

    const handled = await runWorkerTick({ store, executor, resolver });
    expect(handled).toBe(1);
    const row = store.get("r1");
    expect(row?.status).toBe("verified");
    expect(row?.outputHash).toBe(built.wasmHash);
    expect(row?.deployedHash).toBe(built.wasmHash);
  });

  it("marks a job failed on a hash mismatch", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job(C1));
    const handled = await runWorkerTick({
      store,
      executor: stubBuildExecutor(),
      resolver: createStaticArtifactResolver({ [C1]: "f".repeat(64) }),
    });
    expect(handled).toBe(1);
    expect(store.get("r1")?.status).toBe("failed");
    expect(store.get("r1")?.log).toContain("Mismatch");
  });

  it("does nothing (handled=0) when the queue is idle", async () => {
    const store = createMemoryJobStore();
    const handled = await runWorkerTick({
      store,
      executor: stubBuildExecutor(),
      resolver: createStaticArtifactResolver({}),
    });
    expect(handled).toBe(0);
  });

  it("does not re-claim a job already in-flight", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job(C1));
    await runWorkerTick({
      store,
      executor: stubBuildExecutor(),
      resolver: createStaticArtifactResolver({ [C1]: "a".repeat(64) }),
    });
    // Second tick: the record is now terminal (failed), nothing left to claim.
    const handled = await runWorkerTick({
      store,
      executor: stubBuildExecutor(),
      resolver: createStaticArtifactResolver({ [C1]: "a".repeat(64) }),
    });
    expect(handled).toBe(0);
  });

  it("processes a batch and isolates a single unexpected failure", async () => {
    const store = createMemoryJobStore();
    const boomJob = { ...job(C2), repoUrl: "https://github.com/example/boom" };
    store.submit("ok", job(C1));
    store.submit("boom", boomJob);

    // Executor throws a NON-BuildExecutorError only for the boom repo →
    // runVerification rethrows → the tick logs and continues; "ok" still
    // completes. (contractId isn't part of BuildInput, so we branch on repoUrl.)
    const executor: BuildExecutor = {
      async build(input) {
        if (input.repoUrl === boomJob.repoUrl) throw new TypeError("unexpected");
        return stubBuildExecutor().build(input);
      },
    };
    const built = await stubBuildExecutor().build(job(C1));
    const resolver = createStaticArtifactResolver({
      [C1]: built.wasmHash,
      [C2]: "b".repeat(64),
    });
    const errors: string[] = [];
    const handled = await runWorkerTick({
      store,
      executor,
      resolver,
      batchSize: 5,
      log: { info: () => {}, error: (m) => errors.push(m) },
    });

    expect(handled).toBe(2); // both were claimed
    expect(store.get("ok")?.status).toBe("verified");
    // "boom" stays "building" (retryable) and was logged.
    expect(store.get("boom")?.status).toBe("building");
    expect(errors.some((e) => e.includes("boom"))).toBe(true);
  });

  it("respects batchSize", async () => {
    const store = createMemoryJobStore();
    store.submit("a", job(C1));
    store.submit("b", job(C1));
    store.submit("c", job(C1));
    const resolver = createStaticArtifactResolver({ [C1]: "0".repeat(64) });
    const handled = await runWorkerTick({
      store,
      executor: stubBuildExecutor(),
      resolver,
      batchSize: 2,
    });
    expect(handled).toBe(2);
  });

  it("reports the verification outcome + turnaround to metrics", async () => {
    const store = createMemoryJobStore();
    const built = await stubBuildExecutor().build(job(C1));
    const resolver = createStaticArtifactResolver({ [C1]: built.wasmHash }); // match → verified
    // Seed a job submitted 3s ago so turnaround is measurable.
    store.submit("r1", job(C1), Date.now() - 3000);

    const metrics: WorkerMetrics = {
      verificationResult: vi.fn(),
      workerFailure: vi.fn(),
    };
    await runWorkerTick({ store, executor: stubBuildExecutor(), resolver, metrics });

    expect(metrics.verificationResult).toHaveBeenCalledTimes(1);
    const [outcome, turnaround] = (metrics.verificationResult as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(outcome).toBe("verified");
    expect(turnaround).toBeGreaterThanOrEqual(2.5);
    expect(metrics.workerFailure).not.toHaveBeenCalled();
  });

  it("reports a worker failure to metrics on an unexpected error", async () => {
    const store = createMemoryJobStore();
    store.submit("boom", job(C1));
    const executor: BuildExecutor = {
      async build() {
        throw new TypeError("unexpected");
      },
    };
    const metrics: WorkerMetrics = {
      verificationResult: vi.fn(),
      workerFailure: vi.fn(),
    };
    await runWorkerTick({
      store,
      executor,
      resolver: createStaticArtifactResolver({ [C1]: "a".repeat(64) }),
      metrics,
    });
    expect(metrics.workerFailure).toHaveBeenCalledTimes(1);
    expect(metrics.verificationResult).not.toHaveBeenCalled();
  });
});
