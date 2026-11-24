import { createHmac, timingSafeEqual } from "node:crypto";
import type { BuildInput } from "./executor";

/**
 * Verification Job Signature Verification (BUILD-PLAN.md Phase 7 / Issue #421).
 *
 * Job payload signing ensures that only authorized services (verification-service)
 * can schedule builds on the worker. Any direct or unauthorized insertion into
 * the database queue without a valid signature is rejected before execution starts.
 */

export interface VerificationJobPayload extends BuildInput {
  contractId: string;
  timestamp?: number;
  signature?: string;
}

export interface VerificationSignatureResult {
  valid: boolean;
  reason?: "missing_signature" | "invalid_signature" | "expired" | "malformed";
}

export interface RetiredJobSigningKey {
  secret: string;
  /** First instant at which signatures under this key are no longer accepted. */
  expiresAtMs: number;
}

/** Canonical string serialization for HMAC signature computation. */
export function canonicalizeJobPayload(payload: {
  contractId: string;
  sourceType: string;
  repoUrl?: string;
  commitHash?: string;
  sourceArchiveRef?: string;
  toolchainVersion: string;
  buildFlags?: string[];
  timestamp?: number;
}): string {
  return JSON.stringify({
    contractId: payload.contractId,
    sourceType: payload.sourceType,
    repoUrl: payload.repoUrl ?? null,
    commitHash: payload.commitHash ?? null,
    sourceArchiveRef: payload.sourceArchiveRef ?? null,
    toolchainVersion: payload.toolchainVersion,
    buildFlags: payload.buildFlags ?? [],
    timestamp: payload.timestamp ?? 0,
  });
}

/** Compute HMAC-SHA256 signature over the canonical payload. */
export function signJobPayload(
  payload: {
    contractId: string;
    sourceType: string;
    repoUrl?: string;
    commitHash?: string;
    sourceArchiveRef?: string;
    toolchainVersion: string;
    buildFlags?: string[];
    timestamp?: number;
  },
  secret: string,
): string {
  const canonical = canonicalizeJobPayload(payload);
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Verifies a job payload against the expected secret.
 * Fails closed: unsigned, tampered, or expired payloads return valid: false.
 */
export function verifyJobSignature(
  job: VerificationJobPayload,
  secret: string,
  options?: {
    maxAgeMs?: number;
    nowMs?: number;
    retiredKeys?: readonly RetiredJobSigningKey[];
  },
): VerificationSignatureResult {
  if (!job.signature) {
    return { valid: false, reason: "missing_signature" };
  }

  const now = options?.nowMs ?? Date.now();

  // Check expiration if timestamp is present and maxAge is configured
  if (options?.maxAgeMs && job.timestamp) {
    if (now - job.timestamp > options.maxAgeMs || job.timestamp > now + 60_000) {
      return { valid: false, reason: "expired" };
    }
  }

  try {
    const actual = Buffer.from(job.signature, "hex");
    const matches = (candidate: string) => {
      const expected = Buffer.from(signJobPayload(job, candidate), "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    };

    if (
      matches(secret) ||
      options?.retiredKeys?.some((key) => now < key.expiresAtMs && matches(key.secret))
    ) {
      return { valid: true };
    }

    return { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}
