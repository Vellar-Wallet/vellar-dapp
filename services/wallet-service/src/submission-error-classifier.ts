/**
 * Error classification for transaction submission worker (Issue #291).
 *
 * Distinguishes transient failures (network errors, RPC rate limits,
 * temporary unavailability) from permanent failures (invalid transaction,
 * budget exceeded, simulation failure) to enable automatic retry-with-backoff
 * for transient errors only.
 *
 * Classification is grounded in the actual error types produced by:
 * - SubmissionError from relayer.ts (relayer-specific and sponsor-specific codes)
 * - Stellar SDK RPC errors (timeouts, connection issues, rate limits)
 * - Node.js network errors (ECONNREFUSED, ENOTFOUND, etc.)
 */

import { SubmissionError } from "./relayer";

export type SubmissionErrorClassification = "transient" | "permanent";

/**
 * Classifies a submission error as transient (retryable with backoff) or
 * permanent (should not retry, fail immediately).
 *
 * TRANSIENT errors (should retry with exponential backoff + jitter):
 * - Network-level timeouts: TimeoutError, ETIMEDOUT, EHOSTUNREACH, ENETUNREACH
 * - Connection issues: ECONNREFUSED, ECONNRESET, ECONNABORTED, EHOSTUNREACH
 * - DNS failures: ENOTFOUND, ESERVFAIL
 * - RPC rate-limiting: HTTP 429, "too many requests"
 * - RPC server temporary errors: HTTP 5xx, "syncing", "not ready", "temporarily unavailable"
 * - Sponsor submission: sponsor_submit_failed (RPC issue)
 * - Unknown/unclassified errors (conservative default): treat as transient
 *
 * PERMANENT errors (should NOT retry, mark as failed immediately):
 * - Invalid transaction: sponsor_bad_tx, simulation_failed
 * - Budget exceeded: sponsor_fee_too_high, sponsor_budget_exceeded
 * - On-chain failure: tx_failed (permanent state on-chain)
 * - Bad configuration: relayer_not_configured
 * - Sponsor-specific failures: sponsor_fee_too_high, sponsor_budget_exceeded
 */
export function isTransientSubmissionFailure(error: unknown): boolean {
  if (error instanceof SubmissionError) {
    const code = error.code.toLowerCase();
    const message = error.message.toLowerCase();

    // Permanent submission errors — never retry
    if (
      code === "sponsor_bad_tx" ||
      code === "sponsor_simulation_failed" ||
      code === "sponsor_fee_too_high" ||
      code === "sponsor_budget_exceeded" ||
      code === "relayer_not_configured" ||
      code === "tx_failed"
    ) {
      return false;
    }

    // Transient sponsor/relayer submission errors — retry with backoff
    if (code === "sponsor_submit_failed" || code === "submission_failed") {
      // Check message for transient indicators
      if (
        message.includes("timeout") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("enotfound") ||
        message.includes("temporarily unavailable") ||
        message.includes("not ready") ||
        message.includes("syncing") ||
        message.includes("rate limit")
      ) {
        return true;
      }
      // Default transient for unknown submission errors
      return true;
    }

    // tx_timeout is transient — the tx may eventually confirm
    if (code === "tx_timeout") {
      return true;
    }
  }

  // Network-level errors (Node.js Error with code property)
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name;

    // TimeoutError — connection timeout, RPC timeout, etc.
    if (name === "TimeoutError" || message.includes("timeout")) {
      return true;
    }

    // Connection errors (transient)
    const code = (error as any).code?.toUpperCase();
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ECONNABORTED" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "ETIMEDOUT"
    ) {
      return true;
    }

    // DNS errors (transient, can recover if DNS service recovers)
    if (code === "ENOTFOUND" || code === "ESERVFAIL") {
      return true;
    }

    // Default: transient (conservative — prefer retry when uncertain)
    return true;
  }

  // Unknown error types: default to transient (conservative approach)
  return true;
}

/**
 * Detailed classification result for observability.
 */
export interface SubmissionErrorClassificationResult {
  classification: SubmissionErrorClassification;
  reason: string;
  code?: string;
  isSubmissionError: boolean;
}

/**
 * Classifies an error with detailed reasoning for logs/metrics.
 */
export function classifySubmissionError(
  error: unknown,
): SubmissionErrorClassificationResult {
  if (error instanceof SubmissionError) {
    const isTransient = isTransientSubmissionFailure(error);
    return {
      classification: isTransient ? "transient" : "permanent",
      code: error.code,
      reason: isTransient
        ? `SubmissionError code="${error.code}" is retryable`
        : `SubmissionError code="${error.code}" is not retryable`,
      isSubmissionError: true,
    };
  }

  if (error instanceof Error) {
    const isTransient = isTransientSubmissionFailure(error);
    return {
      classification: isTransient ? "transient" : "permanent",
      reason: isTransient
        ? `${error.name}: ${error.message} (network-level, retryable)`
        : `${error.name}: ${error.message} (permanent)`,
      isSubmissionError: false,
    };
  }

  // Unknown error type
  return {
    classification: "transient",
    reason: "Unknown error type; defaulting to transient (will retry)",
    isSubmissionError: false,
  };
}
