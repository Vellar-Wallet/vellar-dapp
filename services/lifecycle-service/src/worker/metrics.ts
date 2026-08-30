/**
 * Cleanup worker metrics (Issue #293).
 *
 * Prometheus metrics for monitoring cleanup job queue processing and
 * detecting out-of-order job processing attempts.
 */

import type { Registry } from "prom-client";
import { Counter } from "prom-client";

export interface CleanupMetrics {
  cleanupJobsClaimed: Counter;
  cleanupJobsCompleted: Counter;
  cleanupJobsFailed: Counter;
  /** Out-of-order detection metric: incremented when jobs for the same account are processed out of sequence */
  cleanupOutOfOrder: Counter;
}

export function registerCleanupMetrics(registry: Registry): CleanupMetrics {
  const cleanupJobsClaimed = new Counter({
    name: "vela_cleanup_jobs_claimed_total",
    help: "Total number of cleanup jobs claimed for processing",
    registers: [registry],
  });

  const cleanupJobsCompleted = new Counter({
    name: "vela_cleanup_jobs_completed_total",
    help: "Total number of cleanup jobs successfully completed",
    registers: [registry],
  });

  const cleanupJobsFailed = new Counter({
    name: "vela_cleanup_jobs_failed_total",
    help: "Total number of cleanup jobs failed (invalid input, account not found, etc)",
    registers: [registry],
  });

  const cleanupOutOfOrder = new Counter({
    name: "vela_cleanup_out_of_order_total",
    help: "Total number of out-of-order cleanup processing attempts detected (per-account sequencing violated)",
    registers: [registry],
  });

  return {
    cleanupJobsClaimed,
    cleanupJobsCompleted,
    cleanupJobsFailed,
    cleanupOutOfOrder,
  };
}
