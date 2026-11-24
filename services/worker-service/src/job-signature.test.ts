import { describe, expect, it } from "vitest";
import {
  canonicalizeJobPayload,
  signJobPayload,
  verifyJobSignature,
  type VerificationJobPayload,
} from "./job-signature";

describe("Job Payload Signature Hardening (Phase 7 / #421)", () => {
  const secret = "super-secret-build-worker-key-12345678";
  const validJob: VerificationJobPayload = {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    sourceType: "repo",
    repoUrl: "https://github.com/example/contract",
    commitHash: "0123456789abcdef0123456789abcdef01234567",
    toolchainVersion: "1.94.0",
    buildFlags: ["--release"],
    timestamp: 1720000000000,
  };

  it("canonicalizes job payload deterministically", () => {
    const str1 = canonicalizeJobPayload(validJob);
    const str2 = canonicalizeJobPayload({ ...validJob });
    expect(str1).toBe(str2);
  });

  it("generates and verifies valid HMAC-SHA256 signature", () => {
    const signature = signJobPayload(validJob, secret);
    const jobWithSig: VerificationJobPayload = {
      ...validJob,
      signature,
    };
    const result = verifyJobSignature(jobWithSig, secret);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails closed when signature is missing", () => {
    const result = verifyJobSignature(validJob, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature");
  });

  it("fails closed when job payload is tampered (e.g. modified commitHash)", () => {
    const signature = signJobPayload(validJob, secret);
    const tamperedJob: VerificationJobPayload = {
      ...validJob,
      commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      signature,
    };
    const result = verifyJobSignature(tamperedJob, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("fails closed when verified with wrong secret", () => {
    const signature = signJobPayload(validJob, secret);
    const jobWithSig: VerificationJobPayload = {
      ...validJob,
      signature,
    };
    const result = verifyJobSignature(jobWithSig, "wrong-secret-key-0000000000000000");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("honors both grace periods when signing keys rotate in quick succession (#838)", () => {
    const keyA = secret;
    const keyB = "second-build-worker-key";
    const keyC = "third-build-worker-key";
    const jobA = { ...validJob, signature: signJobPayload(validJob, keyA) };
    const jobB = { ...validJob, signature: signJobPayload(validJob, keyB) };
    const jobC = { ...validJob, signature: signJobPayload(validJob, keyC) };
    const start = validJob.timestamp ?? 0;
    const retiredA = { secret: keyA, expiresAtMs: start + 2_000 };
    const retiredB = { secret: keyB, expiresAtMs: start + 2_500 };
    const rejected = { valid: false, reason: "invalid_signature" };

    expect(
      verifyJobSignature(jobA, keyB, { nowMs: start + 1_000, retiredKeys: [retiredA] }),
    ).toEqual({ valid: true });

    const verifyAfterSecondRotation = (job: VerificationJobPayload, elapsedMs: number) =>
      verifyJobSignature(job, keyC, {
        nowMs: start + elapsedMs,
        retiredKeys: [retiredA, retiredB],
      });

    for (const job of [jobA, jobB, jobC]) {
      expect(verifyAfterSecondRotation(job, 1_500)).toEqual({ valid: true });
    }
    expect(verifyAfterSecondRotation({ ...jobA, commitHash: "tampered" }, 1_500)).toEqual(rejected);

    expect(verifyAfterSecondRotation(jobA, 1_999)).toEqual({ valid: true });
    expect(verifyAfterSecondRotation(jobA, 2_000)).toEqual(rejected);
    expect(verifyAfterSecondRotation(jobB, 2_499)).toEqual({ valid: true });
    expect(verifyAfterSecondRotation(jobB, 2_500)).toEqual(rejected);
    expect(verifyAfterSecondRotation(jobC, 2_500)).toEqual({ valid: true });
  });

  it("detects expired signatures when maxAgeMs is configured", () => {
    const now = 1720000000000;
    const oldJob: VerificationJobPayload = {
      ...validJob,
      timestamp: now - 3600_000, // 1 hour ago
    };
    const signature = signJobPayload(oldJob, secret);
    const jobWithSig: VerificationJobPayload = {
      ...oldJob,
      signature,
    };

    const result = verifyJobSignature(jobWithSig, secret, {
      maxAgeMs: 300_000, // 5 minute max age
      nowMs: now,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });
});
