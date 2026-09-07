import { describe, expect, it } from "vitest";
import { runSubmissionLoadTest } from "./load-test-submission";

describe("runSubmissionLoadTest", () => {
  it("measures latency and throughput at increasing concurrency levels", async () => {
    const mockSubmitter = async (id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { hash: `hash_${id}` };
    };

    const res = await runSubmissionLoadTest({
      concurrencyLevels: [1, 2, 4],
      requestsPerLevel: 10,
      mockSubmitter,
    });

    expect(res.summary.length).toBe(3);
    expect(res.summary[0]?.concurrency).toBe(1);
    expect(res.summary[1]?.concurrency).toBe(2);
    expect(res.summary[2]?.concurrency).toBe(4);
    expect(res.passedThresholds).toBe(true);
  });

  it("detects error rate bottleneck when error threshold is exceeded", async () => {
    const mockSubmitter = async (id: number) => {
      if (id >= 5) {
        throw new Error("RPC Rate Exceeded");
      }
      return { hash: `hash_${id}` };
    };

    const res = await runSubmissionLoadTest({
      concurrencyLevels: [5],
      requestsPerLevel: 10,
      maxErrorRateThreshold: 0.1, // 10%
      mockSubmitter,
    });

    expect(res.summary[0]?.failedRequests).toBe(5);
    expect(res.passedThresholds).toBe(false);
    expect(res.bottleneckConcurrency).toBe(5);
  });
});
