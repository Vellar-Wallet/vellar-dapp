import { describe, expect, it } from "vitest";
import { isUserCancellation, normalizePasskeyError, PasskeyError, toPasskeyError, PASSKEY_ERROR_MESSAGES } from "./errors";

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

describe("toPasskeyError (issue #551)", () => {
  function domException(name: string, message = "webauthn failed") {
    const err = new Error(message);
    err.name = name;
    return err;
  }

  it("maps NotAllowedError with no authenticator to no-authenticator with distinct message", () => {
    const result = toPasskeyError(domException("NotAllowedError"), false);
    expect(result.code).toBe("no-authenticator");
    expect(result.message).toBe("No passkey authenticator is available on this device.");
  });

  it("maps NotAllowedError with authenticator available to cancelled with distinct message", () => {
    const result = toPasskeyError(domException("NotAllowedError"), true);
    expect(result.code).toBe("cancelled");
    expect(result.message).toBe("Passkey registration was cancelled.");
  });

  it("error messages differ between no-authenticator and user-cancel", () => {
    const noAuth = toPasskeyError(domException("NotAllowedError"), false);
    const cancelled = toPasskeyError(domException("NotAllowedError"), true);
    expect(noAuth.message).not.toBe(cancelled.message);
    expect(noAuth.code).not.toBe(cancelled.code);
  });

  it("maps other DOM errors to their existing codes regardless of hadAuthenticator", () => {
    expect(toPasskeyError(domException("InvalidStateError"), true).code).toBe("credential-exists");
    expect(toPasskeyError(domException("NotSupportedError"), false).code).toBe("unsupported");
    expect(toPasskeyError(domException("SecurityError"), true).code).toBe("security");
    expect(toPasskeyError(domException("AbortError"), false).code).toBe("aborted");
  });

  it("passes through an existing PasskeyError unchanged", () => {
    const original = new PasskeyError("security", "bad origin", undefined);
    expect(toPasskeyError(original, true)).toBe(original);
    expect(toPasskeyError(original, false)).toBe(original);
  });

  it("maps unknown errors to unknown", () => {
    const result = toPasskeyError(new Error("weird"), true);
    expect(result.code).toBe("unknown");
    expect(result.message).toBe("Passkey operation failed.");
  });
});
