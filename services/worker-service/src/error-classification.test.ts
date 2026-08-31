/**
 * Tests for error classification (Issue #295).
 *
 * Verifies that transient vs permanent failure classification correctly
 * distinguishes errors that should be retried from those that should fail
 * immediately. Classification correctness is critical — a misclassification
 * can either waste resources (retrying permanent failures) or reintroduce
 * manual resubmission burden (not retrying transient failures).
 */

import { describe, it, expect } from "vitest";
import { isTransientFailure, classifyError, type ErrorClassificationResult } from "./error-classification";
import { ArtifactResolveError } from "./resolver";
import { BuildExecutorError } from "./executor";

describe("Error Classification (Issue #295)", () => {
  // SUITE 1: Network-level errors (transient)
  describe("network-level errors", () => {
    it("classifies TimeoutError as transient", () => {
      const err = new Error("Request timeout");
      err.name = "TimeoutError";
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies connection refused as transient", () => {
      const err = new Error("ECONNREFUSED: connection refused");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies connection reset as transient", () => {
      const err = new Error("ECONNRESET: connection reset by peer");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies DNS failure (EAI_AGAIN) as transient", () => {
      const err = new Error("EAI_AGAIN: temporary failure in name resolution");
      err.name = "EAI_AGAIN";
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies DNS failure (ENOTFOUND) as transient", () => {
      const err = new Error("ENOTFOUND: getaddrinfo ENOTFOUND example.com");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies socket hang up as transient", () => {
      const err = new Error("socket hang up");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies broken pipe as transient", () => {
      const err = new Error("EPIPE: broken pipe");
      expect(isTransientFailure(err)).toBe(true);
    });
  });

  // SUITE 2: RPC rate-limiting and server errors (transient)
  describe("RPC rate-limiting and availability", () => {
    it("classifies rate limit error as transient", () => {
      const err = new Error("Rate limit exceeded: too many requests");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 429 too many requests as transient", () => {
      const err = new Error("HTTP 429: Too Many Requests");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 500 server error as transient", () => {
      const err = new Error("HTTP 500: Internal Server Error");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 502 bad gateway as transient", () => {
      const err = new Error("HTTP 502: Bad Gateway");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 503 service unavailable as transient", () => {
      const err = new Error("HTTP 503: Service Unavailable");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies RPC node not ready as transient", () => {
      const err = new Error("RPC node is not ready to serve requests");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies RPC node syncing as transient", () => {
      const err = new Error("Node is syncing, cannot serve requests");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies temporary unavailability as transient", () => {
      const err = new Error("Service temporarily unavailable");
      expect(isTransientFailure(err)).toBe(true);
    });
  });

  // SUITE 3: Generic RPC errors (transient by default)
  describe("generic RPC errors (treated as transient by default)", () => {
    it("classifies generic RPC error as transient", () => {
      const err = new Error("RPC error occurred");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies RPC with unknown cause as transient", () => {
      const err = new Error("Failed to connect to RPC endpoint");
      expect(isTransientFailure(err)).toBe(true);
    });
  });

  // SUITE 4: ArtifactResolveError classification (mixed)
  describe("ArtifactResolveError", () => {
    it("classifies 'not_found' (contract doesn't exist) as permanent", () => {
      const err = new ArtifactResolveError("contract not found on-chain", "not_found");
      expect(isTransientFailure(err)).toBe(false);
    });

    it("classifies 'not_wasm' (SAC token) as permanent", () => {
      const err = new ArtifactResolveError("contract is a Stellar Asset Contract", "not_wasm");
      expect(isTransientFailure(err)).toBe(false);
    });

    it("classifies 'rpc_error' as transient (network/availability issue)", () => {
      const err = new ArtifactResolveError("RPC server error", "rpc_error");
      expect(isTransientFailure(err)).toBe(true);
    });
  });

  // SUITE 5: BuildExecutorError classification (mixed)
  describe("BuildExecutorError", () => {
    it("classifies 'not_configured' as permanent", () => {
      const err = new BuildExecutorError("Build executor not configured", "not_configured");
      expect(isTransientFailure(err)).toBe(false);
    });

    it("classifies 'clone_failed' as transient (git service availability)", () => {
      const err = new BuildExecutorError("Git clone failed", "clone_failed", "fatal: unable to access repo");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 'build_failed' as transient (timeout/resource constraint)", () => {
      const err = new BuildExecutorError("Build exited with code 1", "build_failed", "compilation error");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies 'artifact_missing' as permanent", () => {
      const err = new BuildExecutorError("Expected artifact not produced", "artifact_missing");
      expect(isTransientFailure(err)).toBe(false);
    });

    it("classifies 'repo_url_rejected' as permanent (SSRF guard)", () => {
      const err = new BuildExecutorError("URL rejected by SSRF guard", "repo_url_rejected");
      expect(isTransientFailure(err)).toBe(false);
    });

    it("classifies 'unsupported_source' as permanent", () => {
      const err = new BuildExecutorError("Unsupported source type", "unsupported_source");
      expect(isTransientFailure(err)).toBe(false);
    });
  });

  // SUITE 6: Unknown error types (default transient)
  describe("unknown error types", () => {
    it("defaults unknown Error to transient", () => {
      const err = new Error("Something unexpected happened");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("defaults string errors to transient", () => {
      expect(isTransientFailure("some error")).toBe(true);
    });

    it("defaults null to transient", () => {
      expect(isTransientFailure(null)).toBe(true);
    });

    it("defaults undefined to transient", () => {
      expect(isTransientFailure(undefined)).toBe(true);
    });

    it("defaults plain object to transient", () => {
      expect(isTransientFailure({ error: "something" })).toBe(true);
    });
  });

  // SUITE 7: classifyError detailed results
  describe("classifyError detailed classification", () => {
    it("returns transient classification with reason", () => {
      const err = new Error("Connection timeout");
      err.name = "TimeoutError";
      const result = classifyError(err);

      expect(result.classification).toBe("transient");
      expect(result.errorType).toBe("TimeoutError");
      expect(result.reason).toContain("Connection timeout");
    });

    it("includes error code for ArtifactResolveError", () => {
      const err = new ArtifactResolveError("contract not found", "not_found");
      const result = classifyError(err);

      expect(result.classification).toBe("permanent");
      expect(result.errorCode).toBe("not_found");
      expect(result.reason).toContain("not_found");
    });

    it("includes error code for BuildExecutorError", () => {
      const err = new BuildExecutorError("Build failed", "build_failed", "compilation error");
      const result = classifyError(err);

      expect(result.classification).toBe("transient");
      expect(result.errorCode).toBe("build_failed");
    });

    it("handles string errors", () => {
      const result = classifyError("string error");
      expect(result.classification).toBe("transient");
      expect(result.errorType).toBe("string");
    });
  });

  // SUITE 8: Edge cases and realistic scenarios
  describe("edge cases and realistic scenarios", () => {
    it("handles timeout with mixed case", () => {
      const err = new Error("Request TIMEOUT after 30s");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("handles multiple keywords (rate limit + RPC)", () => {
      const err = new Error("RPC rate limit exceeded");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies Stellar SDK timeout correctly", () => {
      // Realistic Stellar SDK error
      const err = new Error("Timeout waiting for response from https://rpc-url");
      expect(isTransientFailure(err)).toBe(true);
    });

    it("classifies Stellar SDK contract not found correctly", () => {
      // Realistic "contract not found" wrapped in ArtifactResolveError
      const err = new ArtifactResolveError(
        "XDRError: unable to decode ContractData",
        "rpc_error",
      );
      // This is classified as transient (generic rpc_error)
      // A true "contract not found" would be classified as "not_found" explicitly
      expect(isTransientFailure(err)).toBe(true);
    });

    it("distinguishes 'contract not found' (permanent) from 'RPC error' (transient)", () => {
      const notFound = new ArtifactResolveError("contract C... not found on-chain", "not_found");
      const rpcError = new ArtifactResolveError("RPC connection failed", "rpc_error");

      expect(isTransientFailure(notFound)).toBe(false);
      expect(isTransientFailure(rpcError)).toBe(true);
    });

    it("git clone timeout is transient (retry may succeed if git service recovers)", () => {
      const err = new BuildExecutorError(
        "Git operation timed out",
        "clone_failed",
        "fatal: connection timeout",
      );
      expect(isTransientFailure(err)).toBe(true);
    });

    it("git authentication failure is treated as transient (might recover with different network/creds)", () => {
      const err = new BuildExecutorError(
        "Git authentication failed",
        "clone_failed",
        "fatal: could not read Username",
      );
      // Classified as transient; if it's a true auth error, retry will fail identically
      // and eventually be dead-lettered
      expect(isTransientFailure(err)).toBe(true);
    });

    it("compilation error is treated as transient (might be timeout/resource constraint)", () => {
      const err = new BuildExecutorError(
        "Build failed",
        "build_failed",
        "error: code compilation failed",
      );
      // Classified as transient; if it's a real compile error, retry will fail identically
      expect(isTransientFailure(err)).toBe(true);
    });
  });
});
