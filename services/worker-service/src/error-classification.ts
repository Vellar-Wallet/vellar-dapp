/**
 * Error classification for contract verification jobs (Issue #295).
 *
 * Distinguishes transient failures (network errors, RPC rate limits, temporary
 * unavailability) from permanent failures (invalid contracts, source/bytecode
 * mismatches, bad requests) to enable automatic retry-with-backoff for transient
 * errors while immediately failing permanent errors.
 *
 * Classification is grounded in the actual error types and shapes produced by:
 * - Stellar SDK rpc.Server for RPC calls
 * - ArtifactResolveError for contract resolution failures
 * - BuildExecutorError for build/clone failures
 * - Standard JavaScript/Node.js error types (TimeoutError, etc.)
 */

import type { ArtifactResolveError } from "./resolver";
import type { BuildExecutorError } from "./executor";

/**
 * Outcome of error classification: either transient (should retry with backoff)
 * or permanent (should not retry, mark as failed immediately).
 */
export type ErrorClassification = "transient" | "permanent";

/**
 * Classifies an error as transient or permanent based on its type and details.
 *
 * TRANSIENT errors (should retry with exponential backoff + jitter):
 * - Network-level failures (timeouts, connection resets, DNS failures)
 * - RPC rate-limiting responses (too many requests)
 * - RPC nodes temporarily unavailable or syncing
 * - Transient RPC server errors (5xx responses, temporary unavailability)
 *
 * PERMANENT errors (should NOT retry, mark as failed immediately):
 * - Contract doesn't exist on-chain (not_found)
 * - Contract is a Stellar Asset Contract with no user source (not_wasm)
 * - Source/bytecode mismatch after verification (verification failure)
 * - Malformed request or invalid input
 * - Build/clone configuration errors
 * - Unsupported source type or missing required fields
 */
export function isTransientFailure(error: unknown): boolean {
  // Network-level errors (transient by nature)
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name;

    // TimeoutError (Node.js built-in) — connection timeout, RPC timeout, etc.
    if (name === "TimeoutError" || message.includes("timeout")) {
      return true;
    }

    // Connection errors (transient)
    if (
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("connection refused") ||
      message.includes("connection reset") ||
      message.includes("network unreachable")
    ) {
      return true;
    }

    // DNS failures (transient, can recover if DNS service recovers)
    if (
      name === "EAI_AGAIN" ||
      name === "ENOTFOUND" ||
      message.includes("dns") ||
      message.includes("enotfound") ||
      message.includes("getaddrinfo")
    ) {
      return true;
    }

    // Socket/network-level errors (transient)
    if (
      message.includes("socket") ||
      message.includes("hang up") ||
      message.includes("broken pipe") ||
      message.includes("epipe") ||
      message.includes("econnaborted")
    ) {
      return true;
    }

    // RPC rate-limiting (transient, will recover after backoff)
    if (message.includes("rate limit") || message.includes("too many requests")) {
      return true;
    }

    // RPC server temporary unavailability or sync issues (transient)
    if (
      message.includes("temporarily unavailable") ||
      message.includes("node is syncing") ||
      message.includes("not ready") ||
      message.includes("not synced")
    ) {
      return true;
    }

    // 5xx server errors from RPC (transient by HTTP convention)
    if (message.includes("500") || message.includes("502") || message.includes("503")) {
      return true;
    }

    // Generic "RPC error" without specific classification — treat as transient
    // by default (it's usually a network/availability issue) unless proven
    // otherwise. This is conservative: we err on the side of retrying rather than
    // immediately failing a potentially recoverable error.
    if (message.includes("rpc") && !message.includes("not found")) {
      return true;
    }
  }

  // ArtifactResolveError classification
  const asResolveError = error as InstanceType<typeof ArtifactResolveError> | undefined;
  if (asResolveError && asResolveError.name === "ArtifactResolveError") {
    const code = asResolveError.code;

    // not_found: contract doesn't exist on-chain (permanent)
    if (code === "not_found") {
      return false;
    }

    // not_wasm: contract is a SAC token, not a user contract (permanent)
    if (code === "not_wasm") {
      return false;
    }

    // rpc_error: treat as transient by default (it likely indicates a network
    // issue, rate limit, or temporary RPC unavailability). If the underlying
    // error message contains permanent-failure indicators, the specific error
    // checks above will have already classified it.
    if (code === "rpc_error") {
      return true;
    }
  }

  // BuildExecutorError classification
  const asExecutorError = error as InstanceType<typeof BuildExecutorError> | undefined;
  if (asExecutorError && asExecutorError.name === "BuildExecutorError") {
    const code = asExecutorError.code;

    // not_configured: build executor not set up (permanent, config error)
    if (code === "not_configured") {
      return false;
    }

    // clone_failed: Git clone/checkout failed (usually permanent — the repo URL
    // is invalid or credentials are wrong). However, GitHub/GitLab rate limits or
    // temporary git service unavailability could cause this. We classify as
    // transient to allow retry, assuming the submitter's repo is valid.
    // If the repo is truly invalid (404, auth error), the retry will fail with
    // the same error and eventually be dead-lettered.
    if (code === "clone_failed") {
      return true; // Treat as potentially transient (network/service availability)
    }

    // build_failed: Docker build exited non-zero or timed out. This is usually
    // permanent (compilation error, missing dependencies specified in build config)
    // but could be transient if the build timed out due to a loaded host. We
    // classify as transient to allow retry on timeout; if it's a real compilation
    // error, the retry will fail identically.
    if (code === "build_failed") {
      return true; // Treat as potentially transient (timeout, temporary resource constraint)
    }

    // artifact_missing: expected wasm path doesn't exist after build, or multiple
    // wasms produced. This is permanent (build process misconfigured or broken).
    if (code === "artifact_missing") {
      return false;
    }

    // repo_url_rejected: SSRF guard rejected the URL (permanent config error)
    if (code === "repo_url_rejected") {
      return false;
    }

    // unsupported_source: source type is not "repo"/"upload" or required fields
    // missing (permanent input error)
    if (code === "unsupported_source") {
      return false;
    }
  }

  // Unknown error type: default to transient (conservative — retry rather than
  // immediately fail something we don't recognize)
  return true;
}

/**
 * Detailed classification result, useful for logging and debugging.
 */
export interface ErrorClassificationResult {
  classification: ErrorClassification;
  reason: string;
  errorType: string;
  errorCode?: string;
}

/**
 * Classifies an error and returns a detailed explanation.
 */
export function classifyError(error: unknown): ErrorClassificationResult {
  const transient = isTransientFailure(error);
  const classification: ErrorClassification = transient ? "transient" : "permanent";

  let errorType = "unknown";
  let errorCode: string | undefined;
  let reason = "Unknown error";

  if (error instanceof Error) {
    errorType = error.name;
    reason = error.message;

    // Special handling for ArtifactResolveError
    if ("code" in error && typeof (error as any).code === "string") {
      errorCode = (error as any).code;
      reason = `${errorType} (${errorCode}): ${error.message}`;
    }
  } else if (typeof error === "string") {
    errorType = "string";
    reason = error;
  } else {
    reason = String(error);
  }

  return {
    classification,
    reason,
    errorType,
    errorCode,
  };
}
