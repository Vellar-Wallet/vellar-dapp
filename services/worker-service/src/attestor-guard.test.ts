import { describe, expect, it } from "vitest";
import { attestorNetwork, assertAttestorSafeForNetwork } from "./attestor-guard";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

describe("attestorNetwork", () => {
  it("classifies the mainnet passphrase as mainnet, everything else as testnet", () => {
    expect(attestorNetwork(MAINNET)).toBe("mainnet");
    expect(attestorNetwork(TESTNET)).toBe("testnet");
    expect(attestorNetwork("Standalone Network ; February 2017")).toBe("testnet");
  });
});

describe("assertAttestorSafeForNetwork (M5 hard guard)", () => {
  it("allows the single-key attestor on testnet", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ networkPassphrase: TESTNET, allowSingleKey: false }),
    ).not.toThrow();
  });

  it("REFUSES the single-key attestor on mainnet (M5: one hot key = total provenance forgery)", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ networkPassphrase: MAINNET, allowSingleKey: false }),
    ).toThrow(/single-key attestor/i);
  });

  it("allows mainnet only with the explicit ALLOW_SINGLE_KEY_ATTESTOR override", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ networkPassphrase: MAINNET, allowSingleKey: true }),
    ).not.toThrow();
  });
});
