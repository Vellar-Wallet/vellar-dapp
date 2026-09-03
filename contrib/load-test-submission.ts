import { performance } from "node:perf_hooks";

export interface LoadTestConfig {
  concurrencyLevels: number[];
  requestsPerLevel: number;
  mockSubmitter?: (id: number) => Promise<{ hash: string }>;
  targetUrl?: string;
  maxErrorRateThreshold?: number; // e.g. 0.05 (5%)
}

export interface ConcurrencyMetrics {
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTimeMs: number;
  requestsPerSecond: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRatePercent: number;
}

export interface LoadTestResult {
  summary: ConcurrencyMetrics[];
  passedThresholds: boolean;
  bottleneckConcurrency?: number;
}

function calculatePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export async function runSubmissionLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
  const summary: ConcurrencyMetrics[] = [];
  let passedThresholds = true;
  let bottleneckConcurrency: number | undefined;
  const maxAllowedErrorRate = config.maxErrorRateThreshold ?? 0.05;

  const submitFn =
    config.mockSubmitter ??
    (async (id: number) => {
      // Default mock simulation if no target URL or submitter passed
      const latency = Math.floor(20 + Math.random() * 80 + id * 0.5);
      await new Promise((resolve) => setTimeout(resolve, latency));
      if (Math.random() < 0.01 + (id > 30 ? 0.03 : 0)) {
        throw new Error("RPC submission timeout");
      }
      return { hash: `tx_hash_${id}_${Date.now()}` };
    });

  for (const concurrency of config.concurrencyLevels) {
    const totalRequests = config.requestsPerLevel;
    const latencies: number[] = [];
    let successful = 0;
    let failed = 0;

    const startTime = performance.now();

    const tasks: (() => Promise<void>)[] = Array.from({ length: totalRequests }, (_, i) => async () => {
      const start = performance.now();
      try {
        await submitFn(i);
        successful++;
      } catch {
        failed++;
      } finally {
        const duration = performance.now() - start;
        latencies.push(duration);
      }
    });

    // Run tasks in worker pool with max specified concurrency
    const pool = new Set<Promise<void>>();
    for (const task of tasks) {
      if (pool.size >= concurrency) {
        await Promise.race(pool);
      }
      const promise = task().finally(() => pool.delete(promise));
      pool.add(promise);
    }
    await Promise.all(pool);

    const totalTimeMs = performance.now() - startTime;
    latencies.sort((a, b) => a - b);

    const errorRate = failed / totalRequests;
    const metrics: ConcurrencyMetrics = {
      concurrency,
      totalRequests,
      successfulRequests: successful,
      failedRequests: failed,
      totalTimeMs,
      requestsPerSecond: Math.round((totalRequests / (totalTimeMs / 1000)) * 100) / 100,
      p50LatencyMs: Math.round(calculatePercentile(latencies, 50) * 100) / 100,
      p95LatencyMs: Math.round(calculatePercentile(latencies, 95) * 100) / 100,
      p99LatencyMs: Math.round(calculatePercentile(latencies, 99) * 100) / 100,
      errorRatePercent: Math.round(errorRate * 10000) / 100,
    };

    summary.push(metrics);

    if (errorRate > maxAllowedErrorRate) {
      passedThresholds = false;
      if (bottleneckConcurrency === undefined) {
        bottleneckConcurrency = concurrency;
      }
    }
  }

  return { summary, passedThresholds, bottleneckConcurrency };
}

// Standalone CLI runner
if (process.argv[1]?.endsWith("load-test-submission.ts")) {
  console.log("=== Running Transaction Submission Load Test ===");
  const levels = [1, 5, 10, 25, 50];
  runSubmissionLoadTest({ concurrencyLevels: levels, requestsPerLevel: 30 })
    .then((result) => {
      console.table(result.summary);
      if (result.bottleneckConcurrency) {
        console.warn(`Bottleneck detected at concurrency: ${result.bottleneckConcurrency}`);
      }
      console.log(`Passed SLA Thresholds: ${result.passedThresholds}`);
    })
    .catch((err) => {
      console.error("Load test failed:", err);
      process.exit(1);
    });
}
