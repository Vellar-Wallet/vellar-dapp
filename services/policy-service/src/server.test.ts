import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_WINDOW_SECONDS,
  policyHash,
  SPENDING_POLICY_WASM_HASH,
  validateDefinition,
  xlmToStroops,
} from "./templates";
import type { PolicyDeployer } from "./deploy";
import { PolicyDeployError } from "./deploy";
import { buildServer } from "./server";

const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const G2 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

const spendingPolicy = {
  version: "1",
  type: "spending_limit",
  owners: [C1],
  spendingLimits: { dailyXlm: "100", perTxXlm: "25" },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(deployer?: PolicyDeployer) {
  app = buildServer(deployer ? { deployer } : {});
  return app;
}

/** A deployer stub that records its calls and returns a fixed instance. */
function stubDeployer(contractId = C1) {
  const deployInstance = vi.fn(async () => ({ contractId, txHash: "deploytx" }));
  const simulateInstance = vi.fn(async () => ({ ok: true, minResourceFee: "12345" }));
  return {
    deployer: { deployInstance, simulateInstance } as PolicyDeployer,
    deployInstance,
    simulateInstance,
  };
}

describe("validateDefinition", () => {
  it("accepts every valid template shape", () => {
    for (const definition of [
      { version: "1", type: "single_owner", owners: [C1] },
      { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 2 },
      spendingPolicy,
      { version: "1", type: "contract_allowlist", owners: [C1], allowlistedContracts: [C1] },
      {
        version: "1",
        type: "timelock",
        owners: [C1],
        timelocks: { adminActionDelaySeconds: 3600 },
      },
    ]) {
      expect(validateDefinition(definition)).toEqual({ valid: true, errors: [] });
    }
  });

  it.each([
    ["unknown type", { version: "1", type: "yolo", owners: [G1] }, /unknown policy type/],
    [
      "threshold above owners",
      { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 3 },
      /threshold cannot exceed/,
    ],
    [
      "single owner with two owners",
      { version: "1", type: "single_owner", owners: [G1, G2] },
      /owners/,
    ],
    [
      "spending limit with no limits",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: {} },
      /dailyXlm/,
    ],
    [
      "zero spending limit",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "0" } },
      /positive/,
    ],
    [
      "allowlist with G address",
      { version: "1", type: "contract_allowlist", owners: [C1], allowlistedContracts: [G1] },
      /contract address/,
    ],
    [
      "bad owner address",
      { version: "1", type: "single_owner", owners: ["nope"] },
      /Stellar address/,
    ],
  ])("rejects %s", (_label, definition, message) => {
    const result = validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" | ")).toMatch(message);
  });

  it("policyHash is deterministic and content-sensitive", () => {
    const a = policyHash(spendingPolicy as never);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHash({ ...spendingPolicy } as never)).toBe(a);
    expect(
      policyHash({ ...spendingPolicy, spendingLimits: { dailyXlm: "999" } } as never),
    ).not.toBe(a);
  });
});

describe("Policy API", () => {
  it("lists templates with their enforcement", async () => {
    const server = build();
    const res = await server.inject({ url: "/policies/templates" });
    const spending = res.json().find((t: { type: string }) => t.type === "spending_limit");
    expect(spending.enforcement).toEqual({
      kind: "policy-contract",
      wasmHash: SPENDING_POLICY_WASM_HASH,
    });
    expect(res.json()).toHaveLength(5);
  });

  it("generate → review artifacts → GET → deploy records the deployment", async () => {
    const server = build();
    const generated = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(generated.statusCode).toBe(201);
    const { policy } = generated.json();
    expect(policy.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.manifest.enforcement.kind).toBe("policy-contract");
    // The generated policy carries the per-user constructor args (dailyXlm=100
    // → 100 XLM in stroops, over the default 24h window).
    expect(policy.manifest.enforcement.constructorArgs).toEqual({
      dailyLimitStroops: "1000000000",
      windowSeconds: DEFAULT_WINDOW_SECONDS,
    });
    expect(policy.status).toBe("generated");

    const fetched = await server.inject({ url: `/policies/${policy.id}` });
    expect(fetched.json().policy.id).toBe(policy.id);

    const deployed = await server.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId: policy.id, txHash: "abc123", contractId: C1 },
    });
    expect(deployed.json().policy.status).toBe("deployed");
    expect(deployed.json().policy.deployment.contractId).toBe(C1);
  });

  it("generate rejects invalid policies with 422 + errors", async () => {
    const server = build();
    const res = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: {
        definition: { version: "1", type: "multisig_threshold", owners: [G1], threshold: 5 },
        network: "testnet",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.length).toBeGreaterThan(0);
  });

  it("deploy 404s for unknown policies; GET 404s too", async () => {
    const server = build();
    const deploy = await server.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId: "nope", txHash: "x" },
    });
    expect(deploy.statusCode).toBe(404);
    const get = await server.inject({ url: "/policies/nope" });
    expect(get.statusCode).toBe(404);
  });
});

describe("xlmToStroops", () => {
  it.each([
    ["1", "10000000"],
    ["100", "1000000000"],
    ["0.5", "5000000"],
    ["12.5", "125000000"],
    ["0.0000001", "1"],
    ["1.2345678", "12345678"], // truncates the 8th decimal
  ])("%s XLM → %s stroops", (xlm, stroops) => {
    expect(xlmToStroops(xlm).toString()).toBe(stroops);
  });
});

describe("POST /policies/:id/deploy-instance", () => {
  async function generateSpending(server: FastifyInstance) {
    const res = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    return res.json().policy as { id: string };
  }

  it("deploys the instance bound to the wallet with the derived constructor args", async () => {
    const { deployer, deployInstance } = stubDeployer();
    const server = build(deployer);
    const policy = await generateSpending(server);

    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().contractId).toBe(C1);
    expect(res.json().policy.status).toBe("instance_deployed");
    expect(res.json().policy.instance.contractId).toBe(C1);
    // The wallet + the user's chosen limit (100 XLM) reach the deployer.
    expect(deployInstance).toHaveBeenCalledWith({
      wallet: C1,
      dailyLimitStroops: xlmToStroops("100").toString(),
      windowSeconds: DEFAULT_WINDOW_SECONDS,
    });
  });

  it("is idempotent — a second call returns the existing instance without redeploying", async () => {
    const { deployer, deployInstance } = stubDeployer();
    const server = build(deployer);
    const policy = await generateSpending(server);

    await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    const again = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json().contractId).toBe(C1);
    expect(deployInstance).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when no deployer (sponsor) is configured", async () => {
    const server = build(); // no deployer
    const policy = await generateSpending(server);
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(503);
  });

  it("404s for an unknown policy", async () => {
    const { deployer } = stubDeployer();
    const server = build(deployer);
    const res = await server.inject({
      method: "POST",
      url: "/policies/nope/deploy-instance",
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s for a policy that is not enforced by a deployed contract", async () => {
    const { deployer } = stubDeployer();
    const server = build(deployer);
    // A multisig policy is enforced via signer-limits, not a contract instance.
    const gen = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: {
        definition: { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 2 },
        network: "testnet",
      },
    });
    const { policy } = gen.json();
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s for a bad wallet address", async () => {
    const { deployer } = stubDeployer();
    const server = build(deployer);
    const policy = await generateSpending(server);
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: "not-a-contract" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("502s (with the deploy error code) when the on-chain deploy fails", async () => {
    const deployInstance = vi.fn(async () => {
      throw new PolicyDeployError("simulated failure", "deploy_simulation_failed");
    });
    const simulateInstance = vi.fn(async () => ({ ok: true }));
    const server = build({ deployInstance, simulateInstance } as PolicyDeployer);
    const policy = await generateSpending(server);
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("deploy_simulation_failed");
  });
});

describe("POST /policies/:id/simulate", () => {
  async function generateSpending(server: FastifyInstance) {
    const res = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    return res.json().policy as { id: string };
  }

  it("dry-runs the deploy and returns the resource fee", async () => {
    const { deployer, simulateInstance, deployInstance } = stubDeployer();
    const server = build(deployer);
    const policy = await generateSpending(server);
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/simulate`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, minResourceFee: "12345" });
    expect(simulateInstance).toHaveBeenCalledWith({
      wallet: C1,
      dailyLimitStroops: xlmToStroops("100").toString(),
      windowSeconds: DEFAULT_WINDOW_SECONDS,
    });
    // Simulation must never submit.
    expect(deployInstance).not.toHaveBeenCalled();
  });

  it("surfaces a failed simulation as ok:false without erroring the request", async () => {
    const simulateInstance = vi.fn(async () => ({ ok: false, error: "bad limit" }));
    const deployInstance = vi.fn();
    const server = build({ simulateInstance, deployInstance } as unknown as PolicyDeployer);
    const policy = await generateSpending(server);
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/simulate`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "bad limit" });
  });

  it("422s for a non-contract-enforced policy", async () => {
    const { deployer } = stubDeployer();
    const server = build(deployer);
    const gen = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: {
        definition: { version: "1", type: "single_owner", owners: [C1] },
        network: "testnet",
      },
    });
    const { policy } = gen.json();
    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/simulate`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(422);
  });
});
