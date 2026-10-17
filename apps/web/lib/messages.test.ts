import { describe, expect, it, vi } from "vitest";
import { isUserCancellation } from "@vellar/passkey";
import { WalletApiError } from "./http-backend";
import {
  createExtensionPostMessage,
  EXTENSION_POST_MESSAGE_CHANNEL,
  MESSAGE_SCHEMA_VERSION,
  parseIncomingExtensionMessage,
  UnsupportedMessageSchemaError,
  validateIncomingExtensionMessage,
  passkeyCause,
  walletErrorMessage,
} from "./messages";

// Shapes as passkey-kit@0.14 constructs them (dist/errors.js): PasskeyKitError
// subclasses carry a numeric `code` and, for WebAuthnError, the DOMException as
// `cause`.
function kitError(name: string, code: number, cause?: unknown) {
  return Object.assign(new Error("kit"), { name, code, cause });
}
const notAllowed = Object.assign(new Error("The operation either timed out or was not allowed."), {
  name: "NotAllowedError",
});

describe("walletErrorMessage / passkeyCause (reconnect failure copy, #469)", () => {
  it("a dismissed prompt wrapped by the kit is still a cancellation", () => {
    const err = kitError("WebAuthnError", 3002, notAllowed);
    expect(isUserCancellation(passkeyCause(err))).toBe(true);
    expect(walletErrorMessage(err)).toMatch(/dismissed/);
  });

  it("no wallet for this passkey says so", () => {
    expect(walletErrorMessage(kitError("PasskeyKitError", 2003))).toMatch(/no vellar wallet/i);
  });

  it("a passkey that is not a signer on the resolved wallet says so", () => {
    expect(walletErrorMessage(kitError("WalletOwnershipError", 2004))).toMatch(/isn't a signer/);
  });

  it("server errors keep the server's message", () => {
    const err = new WalletApiError("Too many authentication attempts", 429, "rate_limited");
    expect(walletErrorMessage(err)).toBe("Too many authentication attempts");
  });

  it("plain DOM errors are unchanged", () => {
    expect(passkeyCause(notAllowed)).toBe(notAllowed);
    expect(walletErrorMessage(notAllowed)).toMatch(/dismissed/);
  });
});

describe("extension-web postMessage schemaVersion protocol (#599)", () => {
  it("stamps schemaVersion: 1 on outgoing messages and accepts valid v1 incoming messages", () => {
    const outgoing = createExtensionPostMessage({
      kind: "request",
      id: "req-1",
      payload: { method: "connect", params: { network: "testnet" } },
    });

    expect(outgoing.schemaVersion).toBe(1);
    expect(outgoing.schemaVersion).toBe(MESSAGE_SCHEMA_VERSION);
    expect(outgoing.channel).toBe(EXTENSION_POST_MESSAGE_CHANNEL);

    const validated = validateIncomingExtensionMessage(outgoing);
    expect(validated).toEqual(outgoing);
    expect(parseIncomingExtensionMessage(outgoing)).toEqual(outgoing);
  });

  it("rejects incoming messages missing schemaVersion with a clear error log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missingVersionMsg = {
        channel: EXTENSION_POST_MESSAGE_CHANNEL,
        kind: "request",
        id: "req-missing-version",
        payload: { method: "connect", params: { network: "testnet" } },
      };

      expect(() => validateIncomingExtensionMessage(missingVersionMsg)).toThrow(
        UnsupportedMessageSchemaError,
      );
      expect(() => validateIncomingExtensionMessage(missingVersionMsg)).toThrow(
        /missing schemaVersion.*expected schemaVersion 1/i,
      );
      expect(parseIncomingExtensionMessage(missingVersionMsg)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/missing schemaVersion/i),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects incoming messages with an unknown future schemaVersion (999) with a clear error log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const futureVersionMsg = {
        schemaVersion: 999,
        channel: EXTENSION_POST_MESSAGE_CHANNEL,
        kind: "response",
        id: "res-future-version",
        payload: { method: "connect", result: { address: "CABC", network: "testnet" } },
      };

      expect(() => validateIncomingExtensionMessage(futureVersionMsg)).toThrow(
        UnsupportedMessageSchemaError,
      );
      expect(() => validateIncomingExtensionMessage(futureVersionMsg)).toThrow(
        /unsupported schemaVersion "999".*expected schemaVersion 1/i,
      );
      expect(parseIncomingExtensionMessage(futureVersionMsg)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/unsupported schemaVersion "999"/i),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

