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

/**
 * Default grace period (15 minutes) during which jobs signed by a recently rotated-out
 * secret remain accepted so in-flight queue entries are not dropped across a rollout.
 *
 * Operator rotation procedure:
 * 1. Generate a new HMAC secret and move the old secret into `previousKeys` with
 *    `rotatedAtMs` set to the rotation timestamp.
 * 2. Roll out `worker-service` with the updated keyring before switching
 *    `verification-service` to sign new jobs with `currentSecret`.
 * 3. After `DEFAULT_KEY_ROTATION_GRACE_PERIOD_MS` has elapsed and in-flight jobs
 *    have drained, remove the expired entry from `previousKeys`.
 */
export const DEFAULT_KEY_ROTATION_GRACE_PERIOD_MS = 15 * 60 * 1000;

export interface RotatedSigningKey {
  /** Previous HMAC secret that was rotated out. */
  secret: string;
  /** Epoch timestamp (ms) when this key was rotated out. */
  rotatedAtMs: number;
  /**
   * Optional per-key grace period (ms) after `rotatedAtMs` during which in-flight
   * jobs signed with this key remain valid. Defaults to `DEFAULT_KEY_ROTATION_GRACE_PERIOD_MS`.
   */
  gracePeriodMs?: number;
}

export interface VerificationKeyRing {
  /** Currently active primary signing secret. */
  currentSecret: string;
  /** Previously active secrets retained for in-flight job verification during rotation. */
  previousKeys?: RotatedSigningKey[];
}

export interface VerificationSignatureResult {
  valid: boolean;
  reason?:
    "missing_signature" | "invalid_signature" | "expired" | "key_rotation_expired" | "malformed";
  matchedKey?: "current" | "rotated";
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

function matchesHmacHex(expectedHex: string, actualBuf: Buffer): boolean {
  const expectedBuf = Buffer.from(expectedHex, "hex");
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Verifies a job payload against the expected secret or keyring.
 * Fails closed: unsigned, tampered, expired, or rotated-out payloads return valid: false.
 */
export function verifyJobSignature(
  job: VerificationJobPayload,
  secretOrKeyRing: string | VerificationKeyRing,
  options?: {
    maxAgeMs?: number;
    nowMs?: number;
    previousKeys?: RotatedSigningKey[];
    rotationGracePeriodMs?: number;
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

  const currentSecret =
    typeof secretOrKeyRing === "string" ? secretOrKeyRing : secretOrKeyRing.currentSecret;
  const previousKeys =
    (typeof secretOrKeyRing === "string" ? undefined : secretOrKeyRing.previousKeys) ??
    options?.previousKeys ??
    [];

  try {
    if (!/^[0-9a-fA-F]+$/.test(job.signature) || job.signature.length % 2 !== 0) {
      return { valid: false, reason: "invalid_signature" };
    }

    const actualBuf = Buffer.from(job.signature, "hex");
    const expectedCurrent = signJobPayload(job, currentSecret);

    if (matchesHmacHex(expectedCurrent, actualBuf)) {
      return { valid: true, matchedKey: "current" };
    }

    let matchedExpiredRotatedKey = false;
    for (const rotatedKey of previousKeys) {
      const expectedRotated = signJobPayload(job, rotatedKey.secret);
      if (matchesHmacHex(expectedRotated, actualBuf)) {
        const gracePeriodMs =
          rotatedKey.gracePeriodMs ??
          options?.rotationGracePeriodMs ??
          DEFAULT_KEY_ROTATION_GRACE_PERIOD_MS;
        if (now >= rotatedKey.rotatedAtMs && now - rotatedKey.rotatedAtMs <= gracePeriodMs) {
          return { valid: true, matchedKey: "rotated" };
        }
        matchedExpiredRotatedKey = true;
      }
    }

    if (matchedExpiredRotatedKey) {
      return { valid: false, reason: "key_rotation_expired" };
    }

    return { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}
