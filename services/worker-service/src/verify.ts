import type { VerificationStatus } from "@vela/types";
import { hashesMatch } from "./artifact";
import { BuildExecutorError, type BuildExecutor, type BuildInput } from "./executor";
import { ArtifactResolveError, type ContractArtifactResolver } from "./resolver";

// The verification pipeline (technical-doc.md §7.6): given a job, rebuild the
// contract, resolve the deployed wasm hash, and compare. This module is the
// pure decision logic — no queue, no DB — so every branch (match, mismatch,
// build failure, unresolvable contract) is directly testable.

export interface VerificationJobInput extends BuildInput {
  contractId: string;
}

export interface VerificationOutcome {
  status: Extract<VerificationStatus, "verified" | "failed">;
  /** sha256 of the locally rebuilt artifact (absent if the build failed). */
  outputHash?: string;
  /** The on-chain deployed wasm hash (absent if it couldn't be resolved). */
  deployedHash?: string;
  /** Human-readable explanation + build log, surfaced to the submitter. */
  log: string;
}

export interface RunVerificationDeps {
  executor: BuildExecutor;
  resolver: ContractArtifactResolver;
}

/**
 * Runs one verification job to a terminal outcome. Never throws for expected
 * failure modes (build error, contract not found, hash mismatch) — those are
 * "failed" outcomes with an explanatory log, so the worker can persist a result
 * and move on. Only truly unexpected errors propagate.
 */
export async function runVerification(
  job: VerificationJobInput,
  deps: RunVerificationDeps,
): Promise<VerificationOutcome> {
  // 1. Resolve the on-chain trust anchor first — if the contract doesn't exist
  //    or is a SAC, there is nothing to verify and we skip the expensive build.
  let deployedHash: string;
  try {
    deployedHash = await deps.resolver.resolveDeployedHash(job.contractId);
  } catch (err) {
    if (err instanceof ArtifactResolveError) {
      return {
        status: "failed",
        log: `Could not resolve the deployed contract: ${err.message} (${err.code}).`,
      };
    }
    throw err;
  }

  // 2. Rebuild the contract from the submitted source.
  let build;
  try {
    build = await deps.executor.build(job);
  } catch (err) {
    if (err instanceof BuildExecutorError) {
      return {
        status: "failed",
        deployedHash,
        log: `Build failed: ${err.message} (${err.code}).\n\n${err.log}`.trim(),
      };
    }
    throw err;
  }

  // 3. Compare. Byte-identical rebuild ⇒ verified; anything else ⇒ failed.
  const matched = hashesMatch(build.wasmHash, deployedHash);
  return {
    status: matched ? "verified" : "failed",
    outputHash: build.wasmHash,
    deployedHash,
    log: matched
      ? `Verified: rebuilt artifact matches the deployed wasm hash.\n\n${build.log}`
      : [
          "Mismatch: the rebuilt artifact does not match the deployed contract.",
          `  rebuilt:  ${build.wasmHash}`,
          `  deployed: ${deployedHash}`,
          "",
          build.log,
        ].join("\n"),
  };
}
