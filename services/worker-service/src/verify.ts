import type { VerificationStatus } from "@vellar/types";
import { hashArtifact, hashesMatch, normalizeHash } from "./artifact";
import { BuildExecutorError, type BuildExecutor, type BuildInput } from "./executor";
import { ArtifactResolveError, type ContractArtifactResolver } from "./resolver";
import { isTransientFailure, type ErrorClassification } from "./error-classification";
import { calculateBackoffDelay, BACKOFF_CONFIG } from "./backoff";
import { compareWasm } from "./wasm-compare";
import { isFirstPartyContract } from "./first-party";

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
  timestamp?: number;
  signature?: string;
}

export interface VerificationOutcome {
  status: Extract<VerificationStatus, "verified" | "failed">;
  /** sha256 of the locally rebuilt artifact (absent if the build failed). */
  outputHash?: string;
  /** The on-chain deployed wasm hash (absent if it couldn't be resolved). */
  deployedHash?: string;
  /** How a verified outcome matched (issue #419): "exact" = byte-for-byte;
   * "toolchain-metadata" = identical except the contractmetav0 toolchain stamps
   * (rsver/rssdkver/cliver) — third-party contracts only. Absent on failure. */
  matchMode?: "exact" | "toolchain-metadata";
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

/** Fixed, public guidance for build failures a submitter can act on. Static
 * text only — never err.message, which can carry URLs, hosts or paths (H3). */
const PUBLIC_BUILD_HINTS: Partial<Record<BuildExecutorError["code"], string>> = {
  dependencies_unresolved:
    "Dependencies could not be resolved for an offline build: commit an up-to-date Cargo.lock that uses only crates.io and public https git dependencies (no submodules).",
  dependency_fetch_failed:
    "A dependency host was unreachable while pre-fetching from Cargo.lock; the build will be retried.",
  insufficient_disk_space:
    "The verification worker does not have enough free disk space to pre-fetch dependencies; this is an operator issue, not a problem with the submission.",
};

export interface RunVerificationDeps {
  executor: BuildExecutor;
  resolver: ContractArtifactResolver;
  /** Current retry attempt (0-based). Used for backoff calculation and metrics. */
  retryAttempt?: number;
  /** Base delay in ms for exponential backoff. Defaults to BACKOFF_CONFIG.BASE_DELAY_MS. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms for exponential backoff. Defaults to BACKOFF_CONFIG.MAX_DELAY_MS. */
  maxDelayMs?: number;
  /** Shared secret for job payload cryptographic signature verification (Phase 7). */
  jobSecret?: string;
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

  // 0. Verify job payload cryptographic signature (Phase 7 / Issue #421)
  if (deps.jobSecret) {
    const { verifyJobSignature } = await import("./job-signature");
    const sigResult = verifyJobSignature(job, deps.jobSecret);
    if (!sigResult.valid) {
      return {
        status: "failed",
        statusDetail: `Signature verification failed (${sigResult.reason}).`,
        log: `Verification job rejected: payload signature verification failed (${sigResult.reason}). Fail closed.`,
        isRetryable: false,
        retryAttempt,
      };
    }
  }

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
      const isTransient = isTransientFailure(err);
      const outcome: VerificationOutcome = {
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
        statusDetail: [`Build failed (${err.code}).`, PUBLIC_BUILD_HINTS[err.code]]
          .filter(Boolean)
          .join(" "),
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

  // 3. Compare. Byte-identical rebuild ⇒ verified ("exact").
  if (hashesMatch(build.wasmHash, deployedHash)) {
    return {
      status: "verified",
      matchMode: "exact",
      outputHash: build.wasmHash,
      deployedHash,
      statusDetail: "Rebuilt artifact matches the deployed wasm hash.",
      log: `Verified: rebuilt artifact matches the deployed wasm hash.\n\n${build.log}`,
      isRetryable: false, // Verification success — never retry
      retryAttempt,
    };
  }

  const mismatch = (reason: string, statusDetail: string): VerificationOutcome => ({
    status: "failed",
    outputHash: build.wasmHash,
    deployedHash,
    statusDetail,
    log: [
      "Mismatch: the rebuilt artifact does not match the deployed contract.",
      `  rebuilt:  ${build.wasmHash}`,
      `  deployed: ${deployedHash}`,
      `  reason:   ${reason}`,
      "",
      build.log,
    ].join("\n"),
    isRetryable: false, // permanent — never retry
    retryAttempt,
  });

  // 4. First-party contracts stay byte-for-byte (2026-07-20 binding rule):
  //    they are built AND deployed through the canonical image, so any
  //    difference means the deployed artifact is not the canonical build.
  if (isFirstPartyContract({ repoUrl: job.repoUrl, deployedHash })) {
    return mismatch(
      "first-party contracts must match the canonical build byte-for-byte",
      "Rebuilt artifact does not match the deployed contract.",
    );
  }

  // 5. Third-party: accept a difference ONLY in the contractmetav0 toolchain
  //    stamps (wasm-compare.ts documents exactly which fields and why). Needs
  //    the deployed bytes; a resolver that cannot supply them keeps the
  //    byte-for-byte verdict.
  if (!deps.resolver.fetchDeployedWasm) {
    return mismatch("byte-for-byte only", "Rebuilt artifact does not match the deployed contract.");
  }
  let deployedWasm: Uint8Array;
  try {
    deployedWasm = await deps.resolver.fetchDeployedWasm(deployedHash);
  } catch (err) {
    if (err instanceof ArtifactResolveError) {
      if (err.code === "timeout") throw err; // transient: leave "building" (#330)
      const isTransient = isTransientFailure(err);
      const outcome: VerificationOutcome = {
        status: "failed",
        outputHash: build.wasmHash,
        deployedHash,
        statusDetail: `Could not fetch the deployed wasm (${err.code}).`,
        log: `Could not fetch the deployed wasm for comparison: ${err.message} (${err.code}).`,
        isRetryable: isTransient,
        retryAttempt,
      };
      if (isTransient) {
        outcome.retryDelayMs = calculateBackoffDelay(retryAttempt, baseDelayMs, maxDelayMs);
      }
      return outcome;
    }
    throw err;
  }

  // The bytes compared must be the bytes the reported outputHash describes.
  if (hashArtifact(build.wasm) !== normalizeHash(build.wasmHash)) {
    return mismatch(
      "rebuilt bytes do not hash to the reported rebuilt hash",
      "Rebuilt artifact does not match the deployed contract.",
    );
  }
  const comparison = compareWasm(build.wasm, deployedWasm);
  if (comparison.match === "none") {
    return mismatch(comparison.reason, "Rebuilt artifact does not match the deployed contract.");
  }
  // "exact" here would mean the bytes are equal but the hashes were not — the
  // executor's wasmHash does not describe its wasm. Refuse rather than guess.
  if (comparison.match === "exact") {
    return mismatch(
      "rebuilt bytes match but the reported rebuilt hash does not",
      "Rebuilt artifact does not match the deployed contract.",
    );
  }
  return {
    status: "verified",
    matchMode: "toolchain-metadata",
    outputHash: build.wasmHash,
    deployedHash,
    statusDetail:
      "Rebuilt artifact matches the deployed contract; only toolchain version metadata differs.",
    log: [
      "Verified (toolchain metadata normalized): every code, data, and interface section is",
      "byte-identical; only these contractmetav0 toolchain stamps differ:",
      `  ${comparison.normalizedKeys.join(", ")}`,
      `  rebuilt:  ${build.wasmHash}`,
      `  deployed: ${deployedHash}`,
      "",
      build.log,
    ].join("\n"),
    isRetryable: false,
    retryAttempt,
  };
}
