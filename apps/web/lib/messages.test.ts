import { describe, expect, it } from "vitest";
import { isUserCancellation } from "@vellar/passkey";
import { WalletApiError } from "./http-backend";
import { passkeyCause, walletErrorMessage } from "./messages";

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
