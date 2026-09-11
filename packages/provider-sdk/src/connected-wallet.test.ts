import { describe, expect, it } from "vitest";
import { connectedWalletErrorMessage, connectedWalletPassphrase } from "./connected-wallet";

describe("connectedWalletPassphrase", () => {
  it("maps testnet to the SDF test passphrase", () => {
    expect(connectedWalletPassphrase("testnet")).toBe("Test SDF Network ; September 2015");
  });

  it("maps mainnet to the public network passphrase", () => {
    expect(connectedWalletPassphrase("mainnet")).toBe(
      "Public Global Stellar Network ; September 2015",
    );
  });

  // The passkey path (apps/web/lib/config.ts) defaults to exactly this string;
  // a drift between the two surfaces would sign for the wrong network.
  it("agrees with the passkey path's testnet default", () => {
    expect(connectedWalletPassphrase("testnet")).toBe("Test SDF Network ; September 2015");
  });
});

describe("connectedWalletErrorMessage", () => {
  it("unwraps a real Error", () => {
    expect(connectedWalletErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  // Stellar Wallets Kit rejects with a PLAIN OBJECT, not an Error (see its
  // sdk/utils.ts parseError) — e.g. { code: -1, message: "The user closed the
  // modal." }. An `err instanceof Error` check alone silently drops these.
  it("unwraps the kit's plain {code,message} rejection", () => {
    expect(
      connectedWalletErrorMessage({ code: -1, message: "The user closed the modal." }, "fallback"),
    ).toBe("The user closed the modal.");
  });

  it("unwraps the kit's 'no wallet connected' rejection", () => {
    expect(
      connectedWalletErrorMessage({ code: -1, message: "No wallet has been connected." }, "fb"),
    ).toBe("No wallet has been connected.");
  });

  it("accepts a bare string rejection", () => {
    expect(connectedWalletErrorMessage("nope", "fallback")).toBe("nope");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["message wrong type", { message: 42 }],
    ["empty message", { message: "" }],
    ["array", []],
  ])("falls back for %s", (_label, input) => {
    expect(connectedWalletErrorMessage(input, "fallback")).toBe("fallback");
  });
});
