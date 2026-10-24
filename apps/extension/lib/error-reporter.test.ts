import { describe, it, expect, vi } from "vitest";
import { ErrorReporter, DefaultErrorReportClient, type ErrorReportPayload } from "./error-reporter";

describe("extension error reporter integration (#302)", () => {
  it("includes extension version and browser info in reported errors", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({
      extensionVersion: "1.2.3",
      browserInfo: "Mozilla/5.0 (Windows NT 10.0; Chrome/120.0)",
      client: mockClient,
    });

    const testError = new TypeError("Network request failed");
    const payload = await reporter.reportError(testError, {
      route: "provider-request",
      origin: "https://dapp.example.com",
    });

    expect(payload.name).toBe("TypeError");
    expect(payload.message).toBe("Network request failed");
    expect(payload.context.extensionVersion).toBe("1.2.3");
    expect(payload.context.browserInfo).toBe("Mozilla/5.0 (Windows NT 10.0; Chrome/120.0)");
    expect(payload.context.origin).toBe("https://dapp.example.com");

    const reports = mockClient.getReports();
    expect(reports.length).toBe(1);
    expect(reports[0]).toEqual(payload);
  });

  it("handles non-Error objects and string throws gracefully", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const payload = await reporter.reportError("String error message", {
      handler: "handlePairApproval",
    });

    expect(payload.name).toBe("Error");
    expect(payload.message).toBe("String error message");
    expect(payload.context.handler).toBe("handlePairApproval");
  });

  it("catches client delivery errors without crashing the background worker", async () => {
    const failingClient = {
      send: vi.fn().mockRejectedValue(new Error("Network offline")),
    };
    const reporter = new ErrorReporter({ client: failingClient });

    const payload = await reporter.reportError(new Error("Worker error"));

    expect(failingClient.send).toHaveBeenCalledTimes(1);
    expect(payload.message).toBe("Worker error");
  });
});

describe("credential redaction (#699)", () => {
  /** A representative base64url-shaped value, the length a real credential
   * id / signature / authenticator-data buffer stringifies to. */
  const CREDENTIAL_ID = "QWxhZGRpbjpvcGVuIHNlc2FtZQ".padEnd(48, "xyz_-ABC");
  const SIGNATURE_BYTES = "MEUCIQDx3iR".padEnd(64, "ZYXWVU9876");

  it("never includes a raw passkey credential object placed in the error context", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const rawCredential = {
      id: CREDENTIAL_ID,
      rawId: new Uint8Array([1, 2, 3, 4]),
      type: "public-key",
      response: {
        clientDataJSON: CREDENTIAL_ID,
        authenticatorData: CREDENTIAL_ID,
        signature: SIGNATURE_BYTES,
        userHandle: CREDENTIAL_ID,
      },
    };

    const payload = await reporter.reportError(new Error("Passkey ceremony failed"), {
      credential: rawCredential,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(CREDENTIAL_ID);
    expect(serialized).not.toContain(SIGNATURE_BYTES);
    expect(serialized).not.toMatch(/"rawId":\s*{/); // no leaked byte array either

    const reports = mockClient.getReports();
    expect(JSON.stringify(reports)).not.toContain(CREDENTIAL_ID);
  });

  it("redacts credential-shaped text embedded directly in the error MESSAGE, not just structured fields", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    // Simulates a library that interpolates the raw credential id straight
    // into its thrown message, rather than passing it as a structured field.
    const err = new Error(`WebAuthn assertion failed for credential ${CREDENTIAL_ID}`);
    const payload = await reporter.reportError(err);

    expect(payload.message).not.toContain(CREDENTIAL_ID);
    expect(payload.message).toContain("[redacted");
  });

  it("redacts credential-shaped text embedded in the error STACK", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const err = new Error("assertion failed");
    err.stack = `Error: assertion failed\n    at verify (credential:${CREDENTIAL_ID}:1:1)`;
    const payload = await reporter.reportError(err);

    expect(payload.stack).not.toContain(CREDENTIAL_ID);
  });

  it("leaves ordinary, non-credential-shaped context and short identifiers untouched", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const payload = await reporter.reportError(new Error("Network request failed"), {
      route: "provider-request",
      origin: "https://dapp.example.com",
      requestId: "req-12345", // short — must not be treated as credential data
    });

    expect(payload.context.route).toBe("provider-request");
    expect(payload.context.origin).toBe("https://dapp.example.com");
    expect(payload.context.requestId).toBe("req-12345");
  });

  it("redacts credential data nested inside an array in the context", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const payload = await reporter.reportError(new Error("Multi-signer failure"), {
      attemptedSigners: [{ credentialId: CREDENTIAL_ID }, { credentialId: "short" }],
    });

    const serialized = JSON.stringify(payload.context);
    expect(serialized).not.toContain(CREDENTIAL_ID);
  });
});
