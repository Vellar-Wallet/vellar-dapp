import { describe, it, expect, vi } from "vitest";
import {
  deployPolicyInstance,
  verifyAndRecordAttach,
  simulatePolicyDeploy,
  type DeploymentDeps,
} from "./deployment";
import { AttachUnconfirmedError, AttachMismatchError } from "./verify-attach";
import { PolicyDeployError } from "./deploy";
import type { PolicyRecord, PolicyRepository } from "./server";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POLICY_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

/**
 * Helper to create a minimal PolicyRecord for testing.
 */
function createRecord(overrides?: Partial<PolicyRecord>): PolicyRecord {
  const base: PolicyRecord = {
    id: "policy-123",
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

/**
 * Helper to create mock dependencies.
 */
function createDeps(overrides?: Partial<DeploymentDeps>): DeploymentDeps {
  const policies = new Map<string, PolicyRecord>();
  const repo: PolicyRepository = {
    async insert(record) {
      policies.set(record.id, record);
    },
    async find(id) {
      return policies.get(id);
    },
    async update(record) {
      policies.set(record.id, record);
    },
  };

  return {
    policies: repo,
    deployer: undefined,
    verifyAttach: undefined,
    budget: undefined,
    budgetNetwork: undefined,
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    now: () => new Date("2026-08-29T12:00:00Z"),
    ...overrides,
  };
}

describe("simulatePolicyDeploy", () => {
  it("calls deployer.simulateInstance with wallet and constructor args", async () => {
    const simulateInstance = vi.fn().mockResolvedValue({ ok: true, minResourceFee: "12345" });
    const deps = createDeps({ deployer: { simulateInstance } as never });
    const record = createRecord();

    const result = await simulatePolicyDeploy(deps, record, WALLET);

    expect(result).toEqual({ ok: true, minResourceFee: "12345" });
    expect(simulateInstance).toHaveBeenCalledWith({
      wallet: WALLET,
      constructorArgs: record.manifest.enforcement.constructorArgs,
    });
  });

  it("returns simulation failure without erroring", async () => {
    const simulateInstance = vi.fn().mockResolvedValue({ ok: false, error: "bad limit" });
    const deps = createDeps({ deployer: { simulateInstance } as never });
    const record = createRecord();

    const result = await simulatePolicyDeploy(deps, record, WALLET);

    expect(result).toEqual({ ok: false, error: "bad limit" });
  });

  it("throws if policy is not contract-enforced", async () => {
    const deps = createDeps({ deployer: { simulateInstance: vi.fn() } as never });
    const record = createRecord({
      manifest: { enforcement: { kind: "signer-limits" } },
    });

    await expect(simulatePolicyDeploy(deps, record, WALLET)).rejects.toThrow(/not contract-enforced/);
  });
});

describe("deployPolicyInstance", () => {
  it("consumes budget, deploys instance, updates record, returns updated record", async () => {
    const deployInstance = vi.fn().mockResolvedValue({
      contractId: C1,
      txHash: "deploytx",
    });
    const tryConsume = vi.fn().mockResolvedValue({ ok: true });

    const record = createRecord();
    const deps = createDeps({
      deployer: { deployInstance } as never,
      budget: { tryConsume } as never,
      budgetNetwork: "testnet",
    });

    const { record: updated, contractId } = await deployPolicyInstance(deps, record, WALLET);

    // Budget was consumed
    expect(tryConsume).toHaveBeenCalledWith({
      line: "deploy",
      network: "testnet",
      stroops: expect.any(BigInt),
    });

    // Deployer was called
    expect(deployInstance).toHaveBeenCalledWith({
      wallet: WALLET,
      constructorArgs: record.manifest.enforcement.constructorArgs,
    });

    // Record was updated
    expect(updated.status).toBe("instance_deployed");
    expect(updated.instance).toEqual({
      contractId: C1,
      wallet: WALLET,
      txHash: "deploytx",
      deployedAt: "2026-08-29T12:00:00Z",
    });

    // Result includes contractId
    expect(contractId).toBe(C1);
  });

  it("persists updated record to repository", async () => {
    const deployInstance = vi.fn().mockResolvedValue({ contractId: C1, txHash: "tx" });
    const policies = new Map<string, PolicyRecord>();
    const repo: PolicyRepository = {
      async insert(record) {
        policies.set(record.id, record);
      },
      async find(id) {
        return policies.get(id);
      },
      async update(record) {
        policies.set(record.id, record);
      },
    };

    const record = createRecord();
    const deps = createDeps({
      policies: repo,
      deployer: { deployInstance } as never,
    });

    await deployPolicyInstance(deps, record, WALLET);

    const persisted = policies.get(record.id);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("instance_deployed");
    expect(persisted!.instance).toBeDefined();
  });

  it("throws deploy_budget_exceeded if budget refuses", async () => {
    const tryConsume = vi.fn().mockResolvedValue({ ok: false });
    const deps = createDeps({
      budget: { tryConsume } as never,
      budgetNetwork: "testnet",
      deployer: { deployInstance: vi.fn() } as never,
    });
    const record = createRecord();

    await expect(deployPolicyInstance(deps, record, WALLET)).rejects.toThrow("deploy_budget_exceeded");
  });

  it("fails closed: a budget accounting error refuses the deploy", async () => {
    const tryConsume = vi.fn().mockRejectedValue(new Error("db error"));
    const deps = createDeps({
      budget: { tryConsume } as never,
      budgetNetwork: "testnet",
      deployer: { deployInstance: vi.fn() } as never,
    });
    const record = createRecord();

    await expect(deployPolicyInstance(deps, record, WALLET)).rejects.toThrow("deploy_budget_exceeded");
  });

  it("throws PolicyDeployError if deployer fails", async () => {
    const deployInstance = vi.fn().mockRejectedValue(
      new PolicyDeployError("deploy failed", "deploy_simulation_failed"),
    );
    const deps = createDeps({
      deployer: { deployInstance } as never,
    });
    const record = createRecord();

    await expect(deployPolicyInstance(deps, record, WALLET)).rejects.toThrow(PolicyDeployError);
  });

  it("throws if policy is not contract-enforced", async () => {
    const deps = createDeps({ deployer: { deployInstance: vi.fn() } as never });
    const record = createRecord({
      manifest: { enforcement: { kind: "signer-limits" } },
    });

    await expect(deployPolicyInstance(deps, record, WALLET)).rejects.toThrow(/not contract-enforced/);
  });

  it("skips budget check if budget is not configured", async () => {
    const deployInstance = vi.fn().mockResolvedValue({ contractId: C1, txHash: "tx" });
    const tryConsume = vi.fn();
    const deps = createDeps({
      deployer: { deployInstance } as never,
      budget: undefined, // No budget configured
    });
    const record = createRecord();

    await deployPolicyInstance(deps, record, WALLET);

    expect(tryConsume).not.toHaveBeenCalled();
    expect(deployInstance).toHaveBeenCalled();
  });
});

describe("verifyAndRecordAttach", () => {
  it("verifies attach tx and updates record with deployment info", async () => {
    const verifyAttach = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      verifyAttach: verifyAttach as never,
      network: "testnet",
    });
    const record = createRecord({
      status: "instance_deployed",
      instance: {
        contractId: POLICY_CONTRACT,
        wallet: WALLET,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });

    const updated = await verifyAndRecordAttach(deps, record, "attachtx", C1);

    expect(verifyAttach).toHaveBeenCalledWith(
      deps.verifyAttach,
      {
        txHash: "attachtx",
        network: "testnet",
        wallet: WALLET,
        policyContractId: POLICY_CONTRACT,
      },
      "Test SDF Network ; September 2015",
    );

    expect(updated.status).toBe("deployed");
    expect(updated.deployment).toEqual({
      contractId: C1,
      txHash: "attachtx",
      deployedAt: "2026-08-29T12:00:00Z",
    });
  });

  it("persists updated record to repository", async () => {
    const verifyAttach = vi.fn().mockResolvedValue(undefined);
    const policies = new Map<string, PolicyRecord>();
    const repo: PolicyRepository = {
      async insert(record) {
        policies.set(record.id, record);
      },
      async find(id) {
        return policies.get(id);
      },
      async update(record) {
        policies.set(record.id, record);
      },
    };

    const record = createRecord({
      status: "instance_deployed",
      instance: {
        contractId: POLICY_CONTRACT,
        wallet: WALLET,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });

    const deps = createDeps({
      policies: repo,
      verifyAttach: verifyAttach as never,
    });

    await verifyAndRecordAttach(deps, record, "attachtx", C1);

    const persisted = policies.get(record.id);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("deployed");
    expect(persisted!.deployment).toBeDefined();
  });

  it("throws AttachUnconfirmedError if verification fails (RPC unreachable)", async () => {
    const verifyAttach = vi.fn().mockRejectedValue(new AttachUnconfirmedError("tx not found"));
    const deps = createDeps({
      verifyAttach: verifyAttach as never,
    });
    const record = createRecord({
      status: "instance_deployed",
      instance: {
        contractId: POLICY_CONTRACT,
        wallet: WALLET,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });

    await expect(verifyAndRecordAttach(deps, record, "missing", C1)).rejects.toThrow(
      AttachUnconfirmedError,
    );
  });

  it("throws AttachMismatchError if verification fails (tx mismatch)", async () => {
    const verifyAttach = vi.fn().mockRejectedValue(new AttachMismatchError("attach mismatch"));
    const deps = createDeps({
      verifyAttach: verifyAttach as never,
    });
    const record = createRecord({
      status: "instance_deployed",
      instance: {
        contractId: POLICY_CONTRACT,
        wallet: WALLET,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });

    await expect(verifyAndRecordAttach(deps, record, "wrongtx", C1)).rejects.toThrow(
      AttachMismatchError,
    );
  });

  it("throws if no instance exists (when verify is enabled)", async () => {
    const verifyAttach = vi.fn();
    const deps = createDeps({
      verifyAttach: verifyAttach as never,
    });
    const record = createRecord({ instance: undefined });

    await expect(verifyAndRecordAttach(deps, record, "tx", C1)).rejects.toThrow("no_instance");
  });

  it("skips verification and records attach if verifyAttach is not configured", async () => {
    const deps = createDeps({ verifyAttach: undefined });
    const record = createRecord({
      status: "instance_deployed",
      instance: undefined, // No instance required if verify is disabled
    });

    const updated = await verifyAndRecordAttach(deps, record, "anytx", C1);

    expect(updated.status).toBe("deployed");
    expect(updated.deployment).toEqual({
      contractId: C1,
      txHash: "anytx",
      deployedAt: "2026-08-29T12:00:00Z",
    });
  });
});
