import { describe, it, expect } from "vitest";
import {
  validatePolicyForDeployment,
  validatePolicyInstance,
  deployBodySchema,
  deployInstanceBodySchema,
  generateBodySchema,
} from "./validation";
import type { PolicyRecord } from "./server";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

const spendingPolicy = {
  version: "1",
  type: "spending_limit",
  owners: [C1],
  spendingLimits: { dailyXlm: "100", perTxXlm: "25" },
};

/**
 * Helper to create a minimal PolicyRecord for testing.
 */
function createRecord(
  overrides?: Partial<PolicyRecord>,
): PolicyRecord {
  const base: PolicyRecord = {
    id: "test-policy",
    createdAt: new Date().toISOString(),
    status: "generated",
    policyHash: "hash123",
    manifest: {
      enforcement: {
        kind: "policy-contract",
        wasmHash: "wasm123",
        constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
      },
    },
  };
  return { ...base, ...overrides };
}

describe("validatePolicyForDeployment", () => {
  it("accepts policies enforced by a contract with constructor args", () => {
    const record = createRecord();
    const result = validatePolicyForDeployment(record);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects policies not enforced by a contract", () => {
    const record = createRecord({
      manifest: {
        enforcement: {
          kind: "signer-limits",
        },
      },
    });
    const result = validatePolicyForDeployment(record);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/enforced without a deployed contract/);
  });

  it("rejects policies with contract enforcement but no constructor args", () => {
    const record = createRecord({
      manifest: {
        enforcement: {
          kind: "policy-contract",
          wasmHash: "wasm123",
        },
      },
    });
    const result = validatePolicyForDeployment(record);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/missing constructor args/);
  });
});

describe("validatePolicyInstance", () => {
  it("accepts records with a deployed instance", () => {
    const record = createRecord({
      instance: {
        contractId: C1,
        wallet: C1,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });
    const result = validatePolicyInstance(record);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects records without an instance", () => {
    const record = createRecord({ instance: undefined });
    const result = validatePolicyInstance(record);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No deployed policy instance/);
  });
});

describe("Zod schemas", () => {
  describe("generateBodySchema", () => {
    it("accepts valid generate requests", () => {
      const result = generateBodySchema.safeParse({
        definition: spendingPolicy,
        network: "testnet",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing definition", () => {
      const result = generateBodySchema.safeParse({
        network: "testnet",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid network", () => {
      const result = generateBodySchema.safeParse({
        definition: spendingPolicy,
        network: "unknown",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("deployBodySchema", () => {
    it("accepts valid deploy requests", () => {
      const result = deployBodySchema.safeParse({
        policyId: "policy-123",
        txHash: "tx-hash",
        contractId: C1,
      });
      expect(result.success).toBe(true);
    });

    it("requires policyId", () => {
      const result = deployBodySchema.safeParse({
        txHash: "tx-hash",
      });
      expect(result.success).toBe(false);
    });

    it("requires txHash", () => {
      const result = deployBodySchema.safeParse({
        policyId: "policy-123",
      });
      expect(result.success).toBe(false);
    });

    it("allows optional contractId", () => {
      const result = deployBodySchema.safeParse({
        policyId: "policy-123",
        txHash: "tx-hash",
      });
      expect(result.success).toBe(true);
      expect(result.data?.contractId).toBeUndefined();
    });
  });

  describe("deployInstanceBodySchema", () => {
    it("accepts valid wallet addresses (C...)", () => {
      const result = deployInstanceBodySchema.safeParse({
        wallet: C1,
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-contract addresses (G...)", () => {
      const result = deployInstanceBodySchema.safeParse({
        wallet: G1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid addresses", () => {
      const result = deployInstanceBodySchema.safeParse({
        wallet: "not-an-address",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing wallet", () => {
      const result = deployInstanceBodySchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
