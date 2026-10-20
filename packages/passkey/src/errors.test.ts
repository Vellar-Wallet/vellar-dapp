import { describe, expect, it } from "vitest";
import {
  isNoAuthenticatorError,
  isUserCancellation,
  normalizePasskeyError,
  PasskeyError,
} from "./errors";

function domException(name: string, message = "webauthn failed") {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("normalizePasskeyError", () => {
  it.each([
    ["NotAllowedError", "cancelled"],
    ["ConstraintError", "no-authenticator"],
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

  it("distinguishes no-authenticator failures from user cancellation with distinct codes and messages (#551)", () => {
    const userCancelled = normalizePasskeyError(
      domException("NotAllowedError", "The operation was cancelled by the user."),
    );
    const noAuthenticator = normalizePasskeyError(
      domException("NotAllowedError", "No available authenticator found on this device."),
    );
    const constraintFailure = normalizePasskeyError(domException("ConstraintError"));

    expect(userCancelled.code).toBe("cancelled");
    expect(isUserCancellation(userCancelled)).toBe(true);
    expect(isNoAuthenticatorError(userCancelled)).toBe(false);

    expect(noAuthenticator.code).toBe("no-authenticator");
    expect(isUserCancellation(noAuthenticator)).toBe(false);
    expect(isNoAuthenticatorError(noAuthenticator)).toBe(true);

    expect(constraintFailure.code).toBe("no-authenticator");
    expect(isUserCancellation(constraintFailure)).toBe(false);
    expect(isNoAuthenticatorError(constraintFailure)).toBe(true);

    // Surfaced error code and message differ clearly between user-cancel and no-authenticator
    expect(noAuthenticator.code).not.toBe(userCancelled.code);
    expect(noAuthenticator.message).not.toBe(userCancelled.message);
    expect(constraintFailure.message).toMatch(/authenticator/i);
  });
});

describe("isUserCancellation", () => {
  it("is true for cancelled and aborted", () => {
    expect(isUserCancellation(domException("NotAllowedError"))).toBe(true);
    expect(isUserCancellation(domException("AbortError"))).toBe(true);
  });

  it("is false for real failures", () => {
    expect(isUserCancellation(domException("SecurityError"))).toBe(false);
    expect(isUserCancellation(domException("ConstraintError"))).toBe(false);
    expect(isUserCancellation(new Error("network down"))).toBe(false);
  });
});
