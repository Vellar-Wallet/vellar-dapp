import { describe, expect, it } from "vitest";
import { configFromEnv, validateBuildTimeoutConfig, VerificationConfigError } from "./config";

describe("verification-service boot config validation (#536)", () => {
  it("accepts a valid positive integer BUILD_TIMEOUT_MS at boot", () => {
    const config = configFromEnv({
      BUILD_TIMEOUT_MS: "600000",
    });
    expect(config.buildTimeoutMs).toBe(600_000);
  });

  it("accepts VERIFY_BUILD_TIMEOUT_MS alias when BUILD_TIMEOUT_MS is omitted", () => {
    const config = configFromEnv({
      VERIFY_BUILD_TIMEOUT_MS: "300000",
    });
    expect(config.buildTimeoutMs).toBe(300_000);
  });

  it("rejects missing BUILD_TIMEOUT_MS at boot with a clear error naming the key", () => {
    expect(() => configFromEnv({})).toThrow(VerificationConfigError);
    expect(() => configFromEnv({})).toThrow(/BUILD_TIMEOUT_MS.*missing required build-timeout/i);
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: "" })).toThrow(/BUILD_TIMEOUT_MS/);
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: "   " })).toThrow(/BUILD_TIMEOUT_MS/);
  });

  it.each([
    ["non-numeric string", "not-a-number"],
    ["alphanumeric suffix", "300s"],
    ["floating point value", "1500.5"],
  ])("rejects %s BUILD_TIMEOUT_MS (%s)", (_label, raw) => {
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: raw })).toThrow(VerificationConfigError);
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: raw })).toThrow(/BUILD_TIMEOUT_MS/);
  });

  it.each([
    ["zero", "0"],
    ["negative integer", "-1"],
    ["large negative value", "-600000"],
  ])("rejects %s BUILD_TIMEOUT_MS (%s)", (_label, raw) => {
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: raw })).toThrow(VerificationConfigError);
    expect(() => configFromEnv({ BUILD_TIMEOUT_MS: raw })).toThrow(
      /BUILD_TIMEOUT_MS.*greater than 0/i,
    );
  });

  it("validateBuildTimeoutConfig validates direct numeric and string inputs", () => {
    expect(validateBuildTimeoutConfig(120_000)).toBe(120_000);
    expect(validateBuildTimeoutConfig("45000")).toBe(45_000);
    expect(() => validateBuildTimeoutConfig(undefined)).toThrow(/BUILD_TIMEOUT_MS/);
    expect(() => validateBuildTimeoutConfig(0)).toThrow(/BUILD_TIMEOUT_MS/);
    expect(() => validateBuildTimeoutConfig(-100)).toThrow(/BUILD_TIMEOUT_MS/);
  });
});
