import type { VerificationStatus } from "@vellar/types";
import { hashesMatch } from "./artifact";
import { BuildExecutorError, type BuildExecutor, type BuildInput } from "./executor";
import { ArtifactResolveError, type ContractArtifactResolver } from "./resolver";
import { isTransientFailure, type ErrorClassification } from "./error-classification";
import { calculateBackoffDelay, BACKOFF_CONFIG } from "./backoff";

// The verification pipeline (technical-doc.md §7.6): given a job, rebuild the
// contract, resolve the deployed wasm hash, and compare. This module is the
// pure decision logic — no queue, no DB — so every branch (match, mismatch,
// build failure, unresolvable contract) is directly testable.
//
// ISSUE #295: Added automatic retry-with-backoff for transient RPC/network
// failures (timeouts, rate limits, temporary unavailability) while immediately
// failing permanent failures (contracts not found, source/bytecode mismatch,
// configuration errors). Retries use exponential backoff with full jitter to
// prevent thundering herd.

export interface VerificationJobInput extends BuildInput {
  contractId: string;
}

export interface VerificationOutcome {
  status: Extract<VerificationStatus, "verified" | "failed">;
  /** sha256 of the locally rebuilt artifact (absent if the build failed). */
  outputHash?: string;
  /** The on-chain deployed wasm hash (absent if it couldn't be resolved). */
  deployedHash?: string;
  /** PUBLIC, sanitized one-line status returned by the verification API — a
   * short reason with NO raw build/clone output, host paths, or resolved IPs
   * (security-audit.md H3/FIX 6). Safe to expose unauthenticated. */
  statusDetail: string;
  /** PRIVATE full build/clone output for operators. Persisted but NOT returned
   * by the public verification API (toPublic strips it). May contain host paths
   * and clone stderr, so it must never be surfaced to submitters. */
  log: string;
  /** Whether this outcome is retryable (transient failure) or terminal (permanent). */
  isRetryable?: boolean;
  /** Recommended delay in ms before retrying (if isRetryable is true). */
  retryDelayMs?: number;
  /** Number of retries this job has already attempted. */
  retryAttempt?: number;
}

export interface RunVerificationDeps {
  executor: BuildExecutor;
  resolver: ContractArtifactResolver;
  /** Current retry attempt (0-based). Used for backoff calculation and metrics. */
  retryAttempt?: number;
  /** Base delay in ms for exponential backoff. Defaults to BACKOFF_CONFIG.BASE_DELAY_MS. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms for exponential backoff. Defaults to BACKOFF_CONFIG.MAX_DELAY_MS. */
  maxDelayMs?: number;
}

/**
 * Runs one verification job to a terminal outcome. Never throws for expected
 * failure modes (build error, contract not found, hash mismatch) — those are
 * "failed" outcomes with an explanatory log, so the worker can persist a result
 * and move on. Only truly unexpected errors propagate.
 *
 * ISSUE #295: Transient failures (network errors, RPC timeouts, rate limits)
 * are marked as retryable with an exponential-backoff delay. Permanent failures
 * (contract not found, mismatched bytecode, config errors) are terminal and
 * not retried.
 */
export async function runVerification(
  job: VerificationJobInput,
  deps: RunVerificationDeps,
): Promise<VerificationOutcome> {
  const retryAttempt = deps.retryAttempt ?? 0;
  const baseDelayMs = deps.baseDelayMs ?? BACKOFF_CONFIG.BASE_DELAY_MS;
  const maxDelayMs = deps.maxDelayMs ?? BACKOFF_CONFIG.MAX_DELAY_MS;

  // 1. Resolve the on-chain trust anchor first — if the contract doesn't exist
  //    or is a SAC, there is nothing to verify and we skip the expensive build.
  let deployedHash: string;
  try {
    deployedHash = await deps.resolver.resolveDeployedHash(job.contractId);
  } catch (err) {
    if (err instanceof ArtifactResolveError) {
      // A timeout is a transient upstream condition, not evidence the
      // contract is missing or genuinely unverifiable (issue #330) — treating
      // it as a terminal "failed" would be a false negative that a submitter
      // can never fix by resubmitting the same, perfectly valid contract.
      // Rethrow so the caller (runWorkerTick) leaves the record "building"
      // and retries it, the same fallback path an unexpected error already
      // gets.
      if (err.code === "timeout") {
        throw err;
      }
      return {
        status: "failed",
        statusDetail: `Could not resolve the deployed contract (${err.code}).`,
        log: `Could not resolve the deployed contract: ${err.message} (${err.code}).`,
        isRetryable: isTransient,
        retryAttempt,
      };

      // If transient, provide backoff delay for next retry
      if (isTransient) {
        outcome.retryDelayMs = calculateBackoffDelay(retryAttempt, baseDelayMs, maxDelayMs);
      }

      return outcome;
    }
    throw err;
  }

  // 2. Rebuild the contract from the submitted source.
  let build;
  try {
    build = await deps.executor.build(job);
  } catch (err) {
    if (err instanceof BuildExecutorError) {
      const isTransient = isTransientFailure(err);
      const outcome: VerificationOutcome = {
        status: "failed",
        deployedHash,
        // Public: the failure CODE only (e.g. clone_failed, build_failed,
        // repo_url_rejected) — never err.log, which may carry clone stderr /
        // host paths (H3). Full detail goes to the private log.
        statusDetail: `Build failed (${err.code}).`,
        log: `Build failed: ${err.message} (${err.code}).\n\n${err.log}`.trim(),
        isRetryable: isTransient,
        retryAttempt,
      };

      // If transient, provide backoff delay for next retry
      if (isTransient) {
        outcome.retryDelayMs = calculateBackoffDelay(retryAttempt, baseDelayMs, maxDelayMs);
      }

      return outcome;
    }
    throw err;
  }

  // 3. Compare. Byte-identical rebuild ⇒ verified; anything else ⇒ failed.
  const matched = hashesMatch(build.wasmHash, deployedHash);
  return {
    status: matched ? "verified" : "failed",
    outputHash: build.wasmHash,
    deployedHash,
    statusDetail: matched
      ? "Rebuilt artifact matches the deployed wasm hash."
      : "Rebuilt artifact does not match the deployed contract.",
    log: matched
      ? `Verified: rebuilt artifact matches the deployed wasm hash.\n\n${build.log}`
      : [
          "Mismatch: the rebuilt artifact does not match the deployed contract.",
          `  rebuilt:  ${build.wasmHash}`,
          `  deployed: ${deployedHash}`,
          "",
          build.log,
        ].join("\n"),
    isRetryable: false, // Verification success or permanent failure — never retry
    retryAttempt,
  };
}
