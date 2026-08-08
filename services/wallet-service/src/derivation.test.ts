import { describe, expect, it } from "vitest";
import {
  assertDerivedContractId,
  defaultDeployerPublicKey,
  deriveWalletContractId,
  DerivationMismatchError,
} from "./derivation";

const TESTNET = "Test SDF Network ; September 2015";
// An arbitrary base64url WebAuthn credential id.
const KEY_ID = "AAECAwQFBgcICQoLDA0ODw";

describe("derivation gate (V1)", () => {
  it("the canonical deployer is a fixed G-address (pins the factory)", () => {
    // If passkey-kit's DEFAULT_DEPLOYER_SEED ever changes, this address changes
    // and the whole gate must be revisited — so pin it explicitly.
    expect(defaultDeployerPublicKey()).toBe(
      "GC2C7AWLS2FMFTQAHW3IBUB4ZXVP4E37XNLEF2IK7IVXBB6CMEPCSXFO",
    );
  });

  it("derives a valid C-address deterministically from the keyId", () => {
    const a = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });
    const b = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });
    expect(a).toBe(b);
    expect(a).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("accepts a contractId that equals derive(keyId)", () => {
    const contractId = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });
    expect(() =>
      assertDerivedContractId(KEY_ID, contractId, { networkPassphrase: TESTNET }),
    ).not.toThrow();
  });

  it("rejects a contractId that does not equal derive(keyId)", () => {
    const wrong = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    expect(() =>
      assertDerivedContractId(KEY_ID, wrong, { networkPassphrase: TESTNET }),
    ).toThrow(DerivationMismatchError);
  });

  it("fails loudly when the passphrase drifts (a testnet-derived id is rejected under mainnet)", () => {
    const testnetId = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });
    expect(() =>
      assertDerivedContractId(KEY_ID, testnetId, {
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    ).toThrow(DerivationMismatchError);
  });

  it("fails loudly when the deployer drifts", () => {
    const canonicalId = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });
    expect(() =>
      assertDerivedContractId(KEY_ID, canonicalId, {
        networkPassphrase: TESTNET,
        deployerPublicKey: "GBP5NAUFWZPTUZOCYU6Q2MZQ2XXHRFM3TJHCZOMTDI2NPC73HEOH6664",
      }),
    ).toThrow(DerivationMismatchError);
  });
});
