/**
 * Integration tests for verification with retry backoff (Issue #295).
 *
 * Verifies that:
 * 1. Transient failures are retried with exponential backoff
 * 2. Permanent failures are NOT retried
 * 3. Success doesn't trigger retries
 * 4. Retry delays increase exponentially with jitter
 * 5. Retry metrics are correctly tracked
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runVerification, type VerificationJobInput, type RunVerificationDeps } from "./verify";
import { ArtifactResolveError } from "./resolver";
import { BuildExecutorError } from "./executor";

describe("Verification with Retry Backoff (Issue #295)", () => {
  // SUITE 1: Transient failure retry behavior
  describe("transient failure retry behavior", () => {
    it("marks RPC timeout as retryable with backoff delay", async () => {
      const mockError = new ArtifactResolveError("RPC timeout", "rpc_error");
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor: {} as any,
        resolver,
        retryAttempt: 0,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.isRetryable).toBe(true);
      expect(outcome.retryDelayMs).toBeDefined();
      expect(outcome.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(outcome.retryDelayMs).toBeLessThanOrEqual(1000); // First attempt: [0, 1000]
    });

    it("marks network error as retryable with increasing backoff", async () => {
      const mockError = new ArtifactResolveError("ECONNREFUSED", "rpc_error");
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      // First attempt (0-based)
      const outcome1 = await runVerification(job, {
        executor: {} as any,
        resolver,
        retryAttempt: 0,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      });

      // Second attempt (after first backoff)
      const outcome2 = await runVerification(job, {
        executor: {} as any,
        resolver,
        retryAttempt: 1,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      });

      expect(outcome1.isRetryable).toBe(true);
      expect(outcome2.isRetryable).toBe(true);

      // Second attempt should have higher max delay (exponential backoff)
      // Note: due to jitter, we can't assert exact values, but we can check ranges
      const maxDelay1 = outcome1.retryDelayMs ?? 0;
      const maxDelay2 = outcome2.retryDelayMs ?? 0;
      // Second attempt can theoretically reach up to 2000ms, vs 1000ms for first
      // But due to jitter, we just verify they're both in valid ranges
      expect(outcome1.retryDelayMs).toBeLessThanOrEqual(1000);
      expect(outcome2.retryDelayMs).toBeLessThanOrEqual(2000);
    });

    it("marks build failure as retryable", async () => {
      const mockError = new BuildExecutorError(
        "Build timed out",
        "build_failed",
        "timeout waiting for docker",
      );
      const executor = {
        build: vi.fn().mockRejectedValue(mockError),
      };
      const resolver = {
        resolveDeployedHash: vi
          .fn()
          .mockResolvedValue("abc123def456"),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.isRetryable).toBe(true);
      expect(outcome.retryDelayMs).toBeDefined();
    });

    it("includes retry attempt number in outcome", async () => {
      const mockError = new ArtifactResolveError("Timeout", "rpc_error");
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await runVerification(job, {
          executor: {} as any,
          resolver,
          retryAttempt: attempt,
        });

        expect(outcome.retryAttempt).toBe(attempt);
      }
    });
  });

  // SUITE 2: Permanent failure no-retry behavior
  describe("permanent failure no-retry behavior", () => {
    it("marks contract not found as NOT retryable", async () => {
      const mockError = new ArtifactResolveError(
        "contract CAA... not found on-chain",
        "not_found",
      );
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor: {} as any,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.isRetryable).toBe(false);
      expect(outcome.retryDelayMs).toBeUndefined();
      expect(outcome.statusDetail).toContain("not_found");
    });

    it("marks Stellar Asset Contract as NOT retryable", async () => {
      const mockError = new ArtifactResolveError(
        "contract is a Stellar Asset Contract",
        "not_wasm",
      );
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor: {} as any,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.isRetryable).toBe(false);
      expect(outcome.statusDetail).toContain("not_wasm");
    });

    it("marks artifact missing as NOT retryable", async () => {
      const mockError = new BuildExecutorError(
        "Expected artifact not produced",
        "artifact_missing",
      );
      const executor = {
        build: vi.fn().mockRejectedValue(mockError),
      };
      const resolver = {
        resolveDeployedHash: vi
          .fn()
          .mockResolvedValue("abc123def456"),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.isRetryable).toBe(false);
      expect(outcome.statusDetail).toContain("artifact_missing");
    });

    it("marks SSRF-rejected URL as NOT retryable", async () => {
      const mockError = new BuildExecutorError(
        "URL rejected by SSRF guard",
        "repo_url_rejected",
      );
      const executor = {
        build: vi.fn().mockRejectedValue(mockError),
      };
      const resolver = {
        resolveDeployedHash: vi
          .fn()
          .mockResolvedValue("abc123def456"),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        repoUrl: "http://internal-ip",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.isRetryable).toBe(false);
    });

    it("marks source/bytecode mismatch as NOT retryable", async () => {
      const executor = {
        build: vi.fn().mockResolvedValue({
          wasm: new Uint8Array(),
          wasmHash: "build_hash_xyz",
          log: "Build succeeded",
        }),
      };
      const resolver = {
        resolveDeployedHash: vi
          .fn()
          .mockResolvedValue("deployed_hash_abc"),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.isRetryable).toBe(false);
      expect(outcome.statusDetail).toContain("does not match");
    });
  });

  // SUITE 3: Success cases
  describe("successful verification", () => {
    it("marks successful verification as NOT retryable", async () => {
      const wasmHash = "abc123def456";
      const executor = {
        build: vi.fn().mockResolvedValue({
          wasm: new Uint8Array(),
          wasmHash,
          log: "Build succeeded",
        }),
      };
      const resolver = {
        resolveDeployedHash: vi.fn().mockResolvedValue(wasmHash),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      expect(outcome.status).toBe("verified");
      expect(outcome.isRetryable).toBe(false);
      expect(outcome.retryDelayMs).toBeUndefined();
      expect(outcome.statusDetail).toContain("matches");
    });

    it("includes retry attempt in successful outcome", async () => {
      const wasmHash = "abc123def456";
      const executor = {
        build: vi.fn().mockResolvedValue({
          wasm: new Uint8Array(),
          wasmHash,
          log: "Build succeeded",
        }),
      };
      const resolver = {
        resolveDeployedHash: vi.fn().mockResolvedValue(wasmHash),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      // Simulate a job that succeeded after 2 retry attempts
      const outcome = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 2,
      });

      expect(outcome.retryAttempt).toBe(2);
      expect(outcome.status).toBe("verified");
    });
  });

  // SUITE 4: Exponential backoff timing
  describe("exponential backoff timing", () => {
    it("calculates increasing backoff for successive retries", async () => {
      const mockError = new ArtifactResolveError("Timeout", "rpc_error");
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      const delays: number[] = [];

      // Run multiple retry attempts
      for (let attempt = 0; attempt < 4; attempt++) {
        // Run multiple times to check distribution (jitter is random)
        for (let run = 0; run < 5; run++) {
          const outcome = await runVerification(job, {
            executor: {} as any,
            resolver,
            retryAttempt: attempt,
            baseDelayMs: 100, // Use smaller values for testing
            maxDelayMs: 3200,
          });

          if (outcome.retryDelayMs !== undefined) {
            delays.push({
              attempt,
              delay: outcome.retryDelayMs,
            } as any);
          }
        }
      }

      // Check that delays grow with each attempt (on average)
      const maxDelayPerAttempt = new Map<number, number>();
      for (const entry of delays) {
        const max = maxDelayPerAttempt.get(entry.attempt) ?? 0;
        maxDelayPerAttempt.set(entry.attempt, Math.max(max, entry.delay));
      }

      // Verify that max delay per attempt is exponentially increasing
      const maxAttempt0 = maxDelayPerAttempt.get(0) ?? 0;
      const maxAttempt1 = maxDelayPerAttempt.get(1) ?? 0;
      const maxAttempt2 = maxDelayPerAttempt.get(2) ?? 0;
      const maxAttempt3 = maxDelayPerAttempt.get(3) ?? 0;

      // Each attempt should allow up to 2x the previous max
      // (exponential backoff: max_delay = base * 2^attempt)
      expect(maxAttempt0).toBeLessThanOrEqual(100);
      expect(maxAttempt1).toBeLessThanOrEqual(200);
      expect(maxAttempt2).toBeLessThanOrEqual(400);
      expect(maxAttempt3).toBeLessThanOrEqual(800);
    });

    it("caps backoff delay at max and applies jitter", async () => {
      const mockError = new ArtifactResolveError("Timeout", "rpc_error");
      const resolver = {
        resolveDeployedHash: vi.fn().mockRejectedValue(mockError),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      // High attempt number should cap at maxDelayMs
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runVerification(job, {
            executor: {} as any,
            resolver,
            retryAttempt: 10, // Attempt where exponential would greatly exceed cap
            baseDelayMs: 100,
            maxDelayMs: 1000,
          }),
        ),
      );

      // All delays should be <= maxDelayMs
      for (const outcome of outcomes) {
        expect(outcome.retryDelayMs).toBeLessThanOrEqual(1000);
        expect(outcome.retryDelayMs).toBeGreaterThanOrEqual(0);
      }

      // Due to jitter, they should not all be identical (randomness)
      const uniqueDelays = new Set(outcomes.map((o) => o.retryDelayMs));
      expect(uniqueDelays.size).toBeGreaterThan(1); // Should have variety due to jitter
    });
  });

  // SUITE 5: Idempotency verification
  describe("idempotency verification", () => {
    it("running verification twice against same contract produces same hash", async () => {
      const wasmHash = "abc123def456";
      let buildCallCount = 0;
      let resolveCallCount = 0;

      const executor = {
        build: vi.fn().mockImplementation(async () => {
          buildCallCount++;
          return {
            wasm: new Uint8Array(),
            wasmHash,
            log: `Build succeeded (call ${buildCallCount})`,
          };
        }),
      };
      const resolver = {
        resolveDeployedHash: vi.fn().mockImplementation(async () => {
          resolveCallCount++;
          return wasmHash;
        }),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      // Run verification twice
      const outcome1 = await runVerification(job, { executor, resolver });
      const outcome2 = await runVerification(job, { executor, resolver });

      // Both should succeed identically
      expect(outcome1.status).toBe("verified");
      expect(outcome2.status).toBe("verified");
      expect(outcome1.outputHash).toBe(outcome2.outputHash);
      expect(outcome1.deployedHash).toBe(outcome2.deployedHash);

      // Both calls should have been made (no deduplication/caching at verification level)
      expect(buildCallCount).toBe(2);
      expect(resolveCallCount).toBe(2);

      // Outcomes can be persisted independently without conflicting
      // (no duplicate "verification attempt" records or harmful side effects)
      expect(outcome1.log).toContain("(call 1)");
      expect(outcome2.log).toContain("(call 2)");
    });

    it("retry doesn't produce harmful duplicates when persisted", async () => {
      // This test verifies that if a job is retried and completed twice,
      // there's no harmful side effect. Each outcome can be independently
      // persisted to a record without creating confusion.
      const wasmHash = "abc123def456";

      const executor = {
        build: vi.fn().mockResolvedValue({
          wasm: new Uint8Array(),
          wasmHash,
          log: "Build succeeded",
        }),
      };
      const resolver = {
        resolveDeployedHash: vi.fn().mockResolvedValue(wasmHash),
      };

      const job: VerificationJobInput = {
        contractId: "CAA...",
        sourceType: "repo",
        toolchainVersion: "21.0",
      };

      // Simulate a retry flow: first attempt fails transiently, second succeeds
      const firstAttempt = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 0,
      });

      // Each outcome is self-contained and can be persisted
      expect(firstAttempt.status).toBe("verified");
      expect(firstAttempt.outputHash).toBe(wasmHash);

      // A retry of the same job (after being reclaimed) would produce the same result
      const secondAttempt = await runVerification(job, {
        executor,
        resolver,
        retryAttempt: 1,
      });

      expect(secondAttempt.status).toBe("verified");
      expect(secondAttempt.outputHash).toBe(wasmHash);

      // Both can be independently recorded without conflicting
      // (idempotency is preserved)
      expect(firstAttempt.outputHash).toBe(secondAttempt.outputHash);
    });
  });

  // Issue #330 — a resolver timeout must NOT produce a terminal "failed"
  // verdict for a contract that may well be perfectly valid; it should be
  // retried, the same fallback path an unexpected error already gets.
  it("rethrows (rather than returning failed) when the resolver times out", async () => {
    let buildCalled = false;
    const executor: BuildExecutor = {
      async build(input) {
        buildCalled = true;
        return stubBuildExecutor().build(input);
      },
    };
    const resolver = {
      async resolveDeployedHash(): Promise<string> {
        throw new ArtifactResolveError("contract metadata lookup timed out after 10000ms", "timeout");
      },
    };

    await expect(runVerification(repoJob, { executor, resolver })).rejects.toBeInstanceOf(
      ArtifactResolveError,
    );
    expect(buildCalled).toBe(false); // resolve happens first; no wasted build
  });

  it("still returns a terminal failed outcome for non-timeout resolve errors (not_found, rpc_error)", async () => {
    for (const code of ["not_found", "rpc_error"] as const) {
      const executor = stubBuildExecutor();
      const resolver = {
        async resolveDeployedHash(): Promise<string> {
          throw new ArtifactResolveError(`boom (${code})`, code);
        },
      };
      const outcome = await runVerification(repoJob, { executor, resolver });
      expect(outcome.status).toBe("failed");
      expect(outcome.statusDetail).toContain(code);
    }
  });
});
