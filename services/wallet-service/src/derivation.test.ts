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
    expect(() => assertDerivedContractId(KEY_ID, wrong, { networkPassphrase: TESTNET })).toThrow(
      DerivationMismatchError,
    );
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

  it("cross-checks derivation against independent Stellar SDK ContractIdPreimage calculation", async () => {
    // Cross-check test (Issue #424): independently calculate the contract address
    // using raw Stellar SDK HashIdPreimage to verify passkey-kit's derivation logic
    const { Address, hash, Keypair, StrKey, xdr } = await import("@stellar/stellar-sdk");
    const keyIdBuffer = Buffer.from(KEY_ID, "base64url");
    const salt = hash(keyIdBuffer);
    const deployerPubKey = Keypair.fromRawEd25519Seed(hash(Buffer.from("kalepail"))).publicKey();

    const fromKit = deriveWalletContractId(KEY_ID, { networkPassphrase: TESTNET });

    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(TESTNET)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: Address.fromString(deployerPubKey).toScAddress(),
            salt,
          }),
        ),
      }),
    );
    const expectedContractId = StrKey.encodeContract(hash(preimage.toXDR()));

    expect(fromKit).toBe(expectedContractId);
  });

  it("regression test: pins the deterministic contract id for a fixed passkey across stellar-sdk upgrades (Issue #519)", () => {
    // CRITICAL: The derived contract address for a given passkey credential id must NEVER change.
    // Existing user smart-account wallets are deployed at this deterministic address.
    // If a stellar-sdk or passkey-kit upgrade alters the encoding, hashing, or preimage routines,
    // existing wallets will derive a different address, permanently locking users out of their funds
    // and breaking all existing wallet mappings (idea.md section 6.1).
    const PINNED_KEY_ID = "AAECAwQFBgcICQoLDA0ODw";
    const EXPECTED_CONTRACT_ID = "CA3TKZ44U5KVK7WHIIXVZ6WXVPNACXRQGKJL65L3I62QJRQF33BDSABY";

    const derived = deriveWalletContractId(PINNED_KEY_ID, { networkPassphrase: TESTNET });

    if (derived !== EXPECTED_CONTRACT_ID) {
      throw new Error(
        `CRITICAL BREAKING CHANGE FOR EXISTING WALLETS: Derived contract address changed from ${EXPECTED_CONTRACT_ID} to ${derived} for keyId "${PINNED_KEY_ID}". ` +
          `A stellar-sdk or passkey-kit update has altered the deterministic address derivation scheme. ` +
          `This will cause existing users to lose access to their deployed smart-account contracts. ` +
          `Do NOT merge this upgrade without verifying derivation backward compatibility!`,
      );
    }

    expect(derived).toBe(EXPECTED_CONTRACT_ID);
  });
});
