import { describe, expect, it, vi } from "vitest";
import { isNoAuthenticatorError, isUserCancellation, PasskeyError } from "./errors";
import {
  createPasskeyCredential,
  detectPasskeySupport,
  hasPlatformAuthenticator,
  type PasskeyEnvironment,
} from "./support";

function env(overrides: Partial<PasskeyEnvironment> = {}): PasskeyEnvironment {
  return {
    isSecureContext: true,
    publicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true },
    ...overrides,
  };
}

describe("detectPasskeySupport", () => {
  it("supports a secure context with WebAuthn", () => {
    expect(detectPasskeySupport(env())).toEqual({ supported: true });
  });

  it("rejects insecure contexts", () => {
    expect(detectPasskeySupport(env({ isSecureContext: false }))).toEqual({
      supported: false,
      reason: "insecure-context",
    });
  });

  it("rejects browsers without PublicKeyCredential", () => {
    expect(detectPasskeySupport(env({ publicKeyCredential: undefined }))).toEqual({
      supported: false,
      reason: "no-webauthn",
    });
  });
});

describe("hasPlatformAuthenticator", () => {
  it("returns true when the platform authenticator is available", async () => {
    await expect(hasPlatformAuthenticator(env())).resolves.toBe(true);
  });

  it("returns false when the check API is missing", async () => {
    await expect(hasPlatformAuthenticator(env({ publicKeyCredential: {} }))).resolves.toBe(false);
  });

  it("returns false when there is no WebAuthn at all", async () => {
    await expect(hasPlatformAuthenticator(env({ publicKeyCredential: undefined }))).resolves.toBe(
      false,
    );
  });

  it("returns false instead of throwing when the browser check fails", async () => {
    const failing = env({
      publicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      },
    });
    await expect(hasPlatformAuthenticator(failing)).resolves.toBe(false);
  });
});

describe("createPasskeyCredential (#551)", () => {
  it("fails with no-authenticator when the browser reports no available authenticator, distinct from user cancellation", async () => {
    const noAuthEnv = env({
      publicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
      },
    });
    const createFn = vi.fn(async () => ({ id: "cred-1" }));

    const noAuthErr = (await createPasskeyCredential(noAuthEnv, createFn).catch(
      (e: unknown) => e,
    )) as PasskeyError;
    expect(noAuthErr).toBeInstanceOf(PasskeyError);
    expect(noAuthErr.code).toBe("no-authenticator");
    expect(isNoAuthenticatorError(noAuthErr)).toBe(true);
    expect(isUserCancellation(noAuthErr)).toBe(false);
    expect(createFn).not.toHaveBeenCalled();

    // Compare with user cancellation during the ceremony
    const cancelErrDom = new Error("The user dismissed the passkey creation dialog.");
    cancelErrDom.name = "NotAllowedError";
    const cancelledErr = (await createPasskeyCredential(env(), async () => {
      throw cancelErrDom;
    }).catch((e: unknown) => e)) as PasskeyError;

    expect(cancelledErr).toBeInstanceOf(PasskeyError);
    expect(cancelledErr.code).toBe("cancelled");
    expect(isUserCancellation(cancelledErr)).toBe(true);
    expect(isNoAuthenticatorError(cancelledErr)).toBe(false);

    // Code and message are clearly distinct between no-authenticator and user cancellation
    expect(noAuthErr.code).not.toBe(cancelledErr.code);
    expect(noAuthErr.message).not.toBe(cancelledErr.message);
  });

  it("surfaces a typed no-webauthn feature-detection failure when the browser does not support WebAuthn at all", async () => {
    const unsupportedBrowserEnv = env({ publicKeyCredential: undefined });
    const createFn = vi.fn(async () => ({ id: "cred-1" }));

    const err = (await createPasskeyCredential(unsupportedBrowserEnv, createFn).catch(
      (e: unknown) => e,
    )) as PasskeyError;

    expect(err).toBeInstanceOf(PasskeyError);
    expect(err.code).toBe("no-webauthn");
    expect(err.message).toMatch(/does not support WebAuthn/i);
    expect(isNoAuthenticatorError(err)).toBe(true);
    expect(isUserCancellation(err)).toBe(false);
    // Ceremony function is never invoked, avoiding a generic runtime TypeError
    expect(createFn).not.toHaveBeenCalled();
  });

  it("returns the created credential when WebAuthn and a platform authenticator are available", async () => {
    const cred = await createPasskeyCredential(env(), async () => ({ id: "cred-ok" }));
    expect(cred).toEqual({ id: "cred-ok" });
  });
});
