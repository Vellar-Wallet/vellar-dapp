import { describe, expect, it, vi } from "vitest";
import { detectPasskeySupport, hasPlatformAuthenticator, type PasskeyEnvironment } from "./support";

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

describe("WebAuthn feature-detection failure (issue #551)", () => {
  it("returns unsupported with no-webauthn reason when PublicKeyCredential is missing", () => {
    const env = { isSecureContext: true, publicKeyCredential: undefined };
    const support = detectPasskeySupport(env);
    expect(support).toEqual({ supported: false, reason: "no-webauthn" });
  });

  it("returns unsupported with insecure-context reason when not in secure context", () => {
    const env = { isSecureContext: false, publicKeyCredential: undefined };
    const support = detectPasskeySupport(env);
    expect(support).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("feature-detection failure is not a runtime error — detectPasskeySupport does not throw", () => {
    const env = { isSecureContext: true, publicKeyCredential: undefined };
    expect(() => detectPasskeySupport(env)).not.toThrow();
    expect(() => detectPasskeySupport({ isSecureContext: false, publicKeyCredential: {} })).not.toThrow();
  });
});
