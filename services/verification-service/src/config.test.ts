import { describe, expect, it } from "vitest";
import { configFromEnv } from "./config";

const validEnv = { VERIFY_BUILD_TIMEOUT_S: "600" };

describe("verification build timeout configuration (#536)", () => {
  it("accepts a positive timeout at boot", () => {
    expect(configFromEnv(validEnv).buildTimeoutSeconds).toBe(600);
  });

  it.each([undefined, "", "0", "-1", "not-a-number"]) (
    "rejects invalid VERIFY_BUILD_TIMEOUT_S value %s",
    (value) => {
      const env = { ...validEnv, VERIFY_BUILD_TIMEOUT_S: value };
      expect(() => configFromEnv(env)).toThrow("VERIFY_BUILD_TIMEOUT_S");
    },
  );
});