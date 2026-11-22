import { describe, expect, it } from "vitest";
import { assertAttestorSafeForNetwork } from "./attestor-guard";

// RA-10: the guard no longer classifies the network from a passphrase — it takes
// the explicit, cross-checked network (resolveNetwork, network-config.test.ts).
// These tests cover only the M5 refusal decision given a known network.
describe("assertAttestorSafeForNetwork (M5 hard guard)", () => {
  it("allows the single-key attestor on testnet", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ network: "testnet", allowSingleKey: false }),
    ).not.toThrow();
  });

  it("REFUSES the single-key attestor on mainnet (M5: one hot key = total provenance forgery)", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ network: "mainnet", allowSingleKey: false }),
    ).toThrow(/single-key attestor/i);
  });

  it("allows mainnet only with the explicit ALLOW_SINGLE_KEY_ATTESTOR override in non-production", () => {
    expect(() =>
      assertAttestorSafeForNetwork({
        network: "mainnet",
        allowSingleKey: true,
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });

  it("HARD-GATES mainnet in production even if allowSingleKey is true (#422)", () => {
    expect(() =>
      assertAttestorSafeForNetwork({
        network: "mainnet",
        allowSingleKey: true,
        nodeEnv: "production",
      }),
    ).toThrow(/escape hatch is hard-gated in production/i);
  });
});

  it("treats unset NODE_ENV on mainnet as requiring explicit opt-in (safer non-production path)", () => {
    // NODE_ENV unset is common in local/CI shells; do not silently allow mainnet single-key.
    expect(() =>
      assertAttestorSafeForNetwork({
        network: "mainnet",
        allowSingleKey: false,
        nodeEnv: undefined,
      }),
    ).toThrow(/single-key attestor/i);
  });

  it("allows unset NODE_ENV on mainnet only with explicit allowSingleKey override", () => {
    expect(() =>
      assertAttestorSafeForNetwork({
        network: "mainnet",
        allowSingleKey: true,
        nodeEnv: undefined,
      }),
    ).not.toThrow();
  });
