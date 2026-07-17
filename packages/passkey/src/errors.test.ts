import { describe, expect, it } from "vitest";
import { isUserCancellation, normalizePasskeyError, PasskeyError } from "./errors";

function domException(name: string, message = "webauthn failed") {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("normalizePasskeyError", () => {
  it.each([
    ["NotAllowedError", "cancelled"],
    ["InvalidStateError", "credential-exists"],
    ["NotSupportedError", "unsupported"],
    ["SecurityError", "security"],
    ["AbortError", "aborted"],
  ] as const)("maps %s to %s", (name, code) => {
    const normalized = normalizePasskeyError(domException(name));
    expect(normalized.code).toBe(code);
    expect(normalized.cause).toBeInstanceOf(Error);
  });

  it("maps unrecognized errors to unknown and keeps the message", () => {
    const normalized = normalizePasskeyError(new Error("weird"));
    expect(normalized.code).toBe("unknown");
    expect(normalized.message).toBe("weird");
  });

  it("handles non-Error values", () => {
    const normalized = normalizePasskeyError("nope");
    expect(normalized.code).toBe("unknown");
    expect(normalized.message).toContain("unknown");
  });

  it("passes through an existing PasskeyError unchanged", () => {
    const original = new PasskeyError("security", "bad origin", undefined);
    expect(normalizePasskeyError(original)).toBe(original);
  });
});

describe("isUserCancellation", () => {
  it("is true for cancelled and aborted", () => {
    expect(isUserCancellation(domException("NotAllowedError"))).toBe(true);
    expect(isUserCancellation(domException("AbortError"))).toBe(true);
  });

  it("is false for real failures", () => {
    expect(isUserCancellation(domException("SecurityError"))).toBe(false);
    expect(isUserCancellation(new Error("network down"))).toBe(false);
  });
});
