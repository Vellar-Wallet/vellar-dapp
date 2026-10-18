import { describe, expect, it } from "vitest";
import {
  assertAttestorSafeForNetwork,
  parseAllowSingleKeyAttestor,
  SingleKeyAttestorOnMainnetError,
} from "./attestor-guard";

// RA-10: the guard no longer classifies the network from a passphrase — it takes
// the explicit, cross-checked network (resolveNetwork, network-config.test.ts).
// These tests cover only the M5 refusal decision given a known network.
describe("assertAttestorSafeForNetwork (M5 hard guard)", () => {
  it("allows the single-key attestor on testnet", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ network: "testnet", allowSingleKey: false }),
    ).not.toThrow();
  });

  it("treats ALLOW_SINGLE_KEY_ATTESTOR=true on testnet as a documented no-op with warning (#537)", () => {
    const warnings: string[] = [];
    const result = assertAttestorSafeForNetwork({
      network: "testnet",
      env: { ALLOW_SINGLE_KEY_ATTESTOR: "true", NODE_ENV: "production" },
      warn: (msg) => warnings.push(msg),
    });

    expect(result).toEqual({
      allowed: true,
      network: "testnet",
      mode: "testnet_redundant_override",
      warning: expect.stringMatching(/ALLOW_SINGLE_KEY_ATTESTOR is set.*no-op/i),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/STELLAR_NETWORK=testnet/i);
  });

  it("REFUSES the single-key attestor on mainnet when ALLOW_SINGLE_KEY_ATTESTOR is unset (#537 inverse)", () => {
    expect(() =>
      assertAttestorSafeForNetwork({ network: "mainnet", allowSingleKey: false }),
    ).toThrow(SingleKeyAttestorOnMainnetError);

    expect(() =>
      assertAttestorSafeForNetwork({
        network: "mainnet",
        env: { NODE_ENV: "development" },
      }),
    ).toThrow(/single-key attestor/i);
  });

  it("allows mainnet only with the explicit ALLOW_SINGLE_KEY_ATTESTOR override in non-production", () => {
    expect(
      assertAttestorSafeForNetwork({
        network: "mainnet",
        allowSingleKey: true,
        nodeEnv: "development",
      }),
    ).toEqual({
      allowed: true,
      network: "mainnet",
      mode: "mainnet_override",
    });
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

  it("parses ALLOW_SINGLE_KEY_ATTESTOR env values consistently", () => {
    expect(parseAllowSingleKeyAttestor("1")).toBe(true);
    expect(parseAllowSingleKeyAttestor("true")).toBe(true);
    expect(parseAllowSingleKeyAttestor("TRUE")).toBe(true);
    expect(parseAllowSingleKeyAttestor("0")).toBe(false);
    expect(parseAllowSingleKeyAttestor("false")).toBe(false);
    expect(parseAllowSingleKeyAttestor(undefined)).toBe(false);
  });
});
