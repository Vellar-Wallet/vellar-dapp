import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "./config";

describe("verification build timeout configuration (#536)", () => {
  it("reads a numeric string from process.env and returns a number at boot", () => {
    vi.stubEnv("VERIFY_BUILD_TIMEOUT_S", "10000");
    try {
      expect(process.env.VERIFY_BUILD_TIMEOUT_S).toBe("10000");
      expect(configFromEnv().buildTimeoutSeconds).toBe(10_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses an environment string the same as a numeric value in a programmatic fixture", () => {
    const fromString = configFromEnv({ VERIFY_BUILD_TIMEOUT_S: "10000" });
    // A plain object can contain a number at runtime, unlike process.env.
    const numericFixture = { VERIFY_BUILD_TIMEOUT_S: 10_000 } as unknown as NodeJS.ProcessEnv;
    expect(fromString.buildTimeoutSeconds).toBe(10_000);
    expect(fromString.buildTimeoutSeconds).toBe(configFromEnv(numericFixture).buildTimeoutSeconds);
  });

  it.each([undefined, "", " ", "0", "-1", "1.5", "Infinity", "10000ms", "not-a-number"])(
    "rejects invalid VERIFY_BUILD_TIMEOUT_S value %s",
    (value) => {
      expect(() => configFromEnv({ VERIFY_BUILD_TIMEOUT_S: value })).toThrow(
        "VERIFY_BUILD_TIMEOUT_S must be a positive integer",
      );
    },
  );
});
