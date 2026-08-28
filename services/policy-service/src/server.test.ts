import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ATTESTATION_REGISTRY_ID,
  DEFAULT_WINDOW_SECONDS,
  policyHash,
  SPENDING_POLICY_WASM_HASH,
  validateDefinition,
  VERIFIED_RECIPIENT_WASM_HASH,
  xlmToStroops,
} from "./templates";
import type { PolicyDeployer } from "./deploy";
import { DEPLOY_FEE, PolicyDeployError } from "./deploy";
import { buildServer, createMemoryPolicyRepository } from "./server";

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

  it("accepts boundary values across all templates", () => {
    for (const definition of [
      // Minimum 1 stroop (0.0000001 XLM)
      {
        version: "1",
        type: "spending_limit",
        owners: [C1],
        spendingLimits: { dailyXlm: "0.0000001", perTxXlm: "0.0000001" },
      },
      // perTxXlm exactly equals dailyXlm
      {
        version: "1",
        type: "spending_limit",
        owners: [C1],
        spendingLimits: { dailyXlm: "100", perTxXlm: "100" },
      },
      // threshold exactly equals owners count
      { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 2 },
      // timelock boundary: minimum delay of 1 second
      {
        version: "1",
        type: "timelock",
        owners: [C1],
        timelocks: { adminActionDelaySeconds: 1 },
      },
      // timelock boundary: maximum delay of 365 days (31536000 seconds)
      {
        version: "1",
        type: "timelock",
        owners: [C1],
        timelocks: { adminActionDelaySeconds: 31_536_000 },
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
      "threshold below 2",
      { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 1 },
      /threshold must be at least 2/,
    ],
    [
      "non-integer threshold",
      { version: "1", type: "multisig_threshold", owners: [G1, G2], threshold: 2.5 },
      /threshold must be an integer/,
    ],
    [
      "duplicate owners in multisig",
      { version: "1", type: "multisig_threshold", owners: [G1, G1], threshold: 2 },
      /duplicate owners are not allowed/,
    ],
    [
      "single owner with two owners",
      { version: "1", type: "single_owner", owners: [G1, G2] },
      /single_owner policy requires exactly one owner/,
    ],
    [
      "spending limit with no limits",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: {} },
      /set dailyXlm and\/or perTxXlm/,
    ],
    [
      "zero spending limit",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "0" } },
      /at least 1 stroop/,
    ],
    [
      "all zeroes decimal spending limit",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "0.0000000" } },
      /at least 1 stroop/,
    ],
    [
      "sub-stroop precision exceeding 7 decimal places",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "0.00000001" } },
      /at most 7 decimal places/,
    ],
    [
      "negative spending limit",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "-5" } },
      /valid decimal amount/,
    ],
    [
      "non-numeric spending limit",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "invalid" } },
      /valid decimal amount/,
    ],
    [
      "perTxXlm exceeds dailyXlm",
      { version: "1", type: "spending_limit", owners: [C1], spendingLimits: { dailyXlm: "50", perTxXlm: "100" } },
      /perTxXlm cannot exceed dailyXlm/,
    ],
    [
      "allowlist with G address",
      { version: "1", type: "contract_allowlist", owners: [C1], allowlistedContracts: [G1] },
      /contract address/,
    ],
    [
      "allowlist with duplicate contracts",
      { version: "1", type: "contract_allowlist", owners: [C1], allowlistedContracts: [C1, C1] },
      /duplicate allowlisted contracts are not allowed/,
    ],
    [
      "timelock with 0 delay",
      { version: "1", type: "timelock", owners: [C1], timelocks: { adminActionDelaySeconds: 0 } },
      /delay must be at least 1 second/,
    ],
    [
      "timelock with negative delay",
      { version: "1", type: "timelock", owners: [C1], timelocks: { adminActionDelaySeconds: -10 } },
      /delay must be at least 1 second/,
    ],
    [
      "timelock exceeding 365 days",
      { version: "1", type: "timelock", owners: [C1], timelocks: { adminActionDelaySeconds: 31_536_001 } },
      /delay cannot exceed 31,536,000 seconds/,
    ],
    [
      "timelock with decimal delay",
      { version: "1", type: "timelock", owners: [C1], timelocks: { adminActionDelaySeconds: 3600.5 } },
      /delay must be an integer/,
    ],
    [
      "bad owner address",
      { version: "1", type: "single_owner", owners: ["nope"] },
      /Stellar address/,
    ],
    [
      "unrecognized field rejected by strict schema",
      { version: "1", type: "single_owner", owners: [C1], unexpectedField: "malicious" },
      /Unrecognized key/,
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
    expect(res.json()).toHaveLength(6);
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

describe("POST /policies/deploy — attach verification (L1)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const POLICY_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

  function addPolicyXdr(wallet: string, policy: string): string {
    const signer = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Policy"),
      nativeToScVal(Address.fromString(policy), { type: "address" }),
      xdr.ScVal.scvVoid(),
    ]);
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(wallet).toScAddress(),
        functionName: "add_signer",
        args: [signer],
      }),
    );
    const op = Operation.invokeHostFunction({ func, auth: [] });
    const src = new Account(Keypair.random().publicKey(), "0");
    return new TransactionBuilder(src, { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  /** A repo pre-seeded with an instance_deployed policy bound to WALLET. */
  async function seededServer(verifyAttach: (h: string) => Promise<unknown>) {
    const policies = createMemoryPolicyRepository();
    const app = buildServer({
      policies,
      verifyAttach: verifyAttach as never,
      network: "testnet",
      networkPassphrase: PASSPHRASE,
    });
    const gen = await app.inject({
      method: "POST",
      url: "/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    const policy = gen.json().policy as { id: string };
    const rec = await policies.find(policy.id);
    await policies.update({
      ...rec!,
      status: "instance_deployed",
      instance: {
        contractId: POLICY_CONTRACT,
        wallet: WALLET,
        txHash: "deploytx",
        deployedAt: new Date().toISOString(),
      },
    });
    return { app, policyId: policy.id };
  }

  it("stamps deployed when the attach tx binds this policy to this wallet", async () => {
    const { app, policyId } = await seededServer(async () => ({
      status: "SUCCESS",
      envelopeXdr: addPolicyXdr(WALLET, POLICY_CONTRACT),
    }));
    const res = await app.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId, txHash: "realhash", contractId: POLICY_CONTRACT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.status).toBe("deployed");
  });

  it("422s a valid-but-unrelated tx (different policy) — does not stamp", async () => {
    const other = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
    const { app, policyId } = await seededServer(async () => ({
      status: "SUCCESS",
      envelopeXdr: addPolicyXdr(WALLET, other),
    }));
    const res = await app.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId, txHash: "somehash", contractId: POLICY_CONTRACT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("attach_mismatch");
  });

  it("503s (does not stamp) when the RPC can't confirm the tx", async () => {
    const { app, policyId } = await seededServer(async () => ({ status: "NOT_FOUND" }));
    const res = await app.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId, txHash: "missing", contractId: POLICY_CONTRACT },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("attach_unconfirmed");
  });

  it("503s when the RPC is unreachable (throws)", async () => {
    const { app, policyId } = await seededServer(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await app.inject({
      method: "POST",
      url: "/policies/deploy",
      payload: { policyId, txHash: "x", contractId: POLICY_CONTRACT },
    });
    expect(res.statusCode).toBe(503);
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
      constructorArgs: {
        dailyLimitStroops: xlmToStroops("100").toString(),
        windowSeconds: DEFAULT_WINDOW_SECONDS,
      },
    });
  });

  it("verified_only: generate bakes the registry, deploy passes it to the deployer", async () => {
    const { deployer, deployInstance } = stubDeployer();
    const server = build(deployer);

    const gen = await server.inject({
      method: "POST",
      url: "/policies/generate",
      payload: {
        definition: { version: "1", type: "verified_only", owners: [C1] },
        network: "testnet",
      },
    });
    expect(gen.statusCode).toBe(201);
    const policy = gen.json().policy as {
      id: string;
      manifest: { enforcement: { wasmHash: string; constructorArgs: { registry: string } } };
    };
    expect(policy.manifest.enforcement.wasmHash).toBe(VERIFIED_RECIPIENT_WASM_HASH);
    expect(policy.manifest.enforcement.constructorArgs).toEqual({
      registry: ATTESTATION_REGISTRY_ID,
    });

    const res = await server.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(200);
    expect(deployInstance).toHaveBeenCalledWith({
      wallet: C1,
      constructorArgs: { registry: ATTESTATION_REGISTRY_ID },
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

  it("consumes the deploy budget with the deploy fee and proceeds when allowed", async () => {
    const { deployer, deployInstance } = stubDeployer();
    const tryConsume = vi.fn().mockResolvedValue({ ok: true });
    app = buildServer({ deployer, budget: { tryConsume }, budgetNetwork: "testnet" });
    const policy = await generateSpending(app);
    const res = await app.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(200);
    expect(tryConsume).toHaveBeenCalledWith({
      line: "deploy",
      network: "testnet",
      stroops: BigInt(DEPLOY_FEE),
    });
    expect(deployInstance).toHaveBeenCalled();
  });

  it("returns 503 (deploy_budget_exceeded) and does NOT deploy when the budget refuses", async () => {
    const { deployer, deployInstance } = stubDeployer();
    app = buildServer({
      deployer,
      budget: { tryConsume: async () => ({ ok: false, reason: "budget_exceeded" }) },
      budgetNetwork: "testnet",
    });
    const policy = await generateSpending(app);
    const res = await app.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("deploy_budget_exceeded");
    expect(deployInstance).not.toHaveBeenCalled();
  });

  it("fails closed: a budget accounting error refuses the deploy", async () => {
    const { deployer, deployInstance } = stubDeployer();
    app = buildServer({
      deployer,
      budget: {
        tryConsume: async () => {
          throw new Error("db down");
        },
      },
      budgetNetwork: "testnet",
    });
    const policy = await generateSpending(app);
    const res = await app.inject({
      method: "POST",
      url: `/policies/${policy.id}/deploy-instance`,
      payload: { wallet: C1 },
    });
    expect(res.statusCode).toBe(503);
    expect(deployInstance).not.toHaveBeenCalled();
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
      constructorArgs: {
        dailyLimitStroops: xlmToStroops("100").toString(),
        windowSeconds: DEFAULT_WINDOW_SECONDS,
      },
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

describe("CSRF protection for admin endpoints (Issue #311)", () => {
  it("generates a valid CSRF token from the token endpoint", async () => {
    const server = build();
    const res = await server.inject({ method: "GET", url: "/admin/csrf-token" });
    expect(res.statusCode).toBe(200);
    const { csrfToken } = res.json();
    expect(csrfToken).toBeDefined();
    expect(typeof csrfToken).toBe("string");
    expect(csrfToken.split(".")).toHaveLength(3);
  });

  it("rejects state-changing admin request when CSRF token is missing (403)", async () => {
    const server = build();
    const res = await server.inject({
      method: "POST",
      url: "/admin/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf_token_missing");
  });

  it("rejects state-changing admin request when CSRF token is invalid/tampered (403)", async () => {
    const server = build();
    const res = await server.inject({
      method: "POST",
      url: "/admin/policies/generate",
      headers: { "x-csrf-token": "bad.token.signature" },
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf_token_invalid");
  });

  it("rejects state-changing admin request when CSRF token is expired (403)", async () => {
    const secret = "test-custom-secret";
    // Build server with 1ms TTL
    const app = buildServer({ csrfSecret: secret, csrfTtlMs: 1 });
    const tokenRes = await app.inject({ method: "GET", url: "/admin/csrf-token" });
    const { csrfToken } = tokenRes.json();

    // Sleep 10ms so token expires
    await new Promise((r) => setTimeout(r, 10));

    const res = await app.inject({
      method: "POST",
      url: "/admin/policies/generate",
      headers: { "x-csrf-token": csrfToken },
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf_token_invalid");
    expect(res.json().reason).toBe("expired");
    await app.close();
  });

  it("accepts state-changing admin request with a valid CSRF token (201)", async () => {
    const server = build();
    const tokenRes = await server.inject({ method: "GET", url: "/admin/csrf-token" });
    const { csrfToken } = tokenRes.json();

    const res = await server.inject({
      method: "POST",
      url: "/admin/policies/generate",
      headers: { "x-csrf-token": csrfToken },
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().policy).toBeDefined();
    expect(res.json().policy.status).toBe("generated");
  });

  it("permits safe read requests without requiring a CSRF token", async () => {
    const server = build();
    const res = await server.inject({ method: "GET", url: "/policies/templates" });
    expect(res.statusCode).toBe(200);
  });

  it("enforces CSRF across all mutation endpoints when enableCsrf is true", async () => {
    const app = buildServer({ enableCsrf: true });
    // Without token -> 403
    const blocked = await app.inject({
      method: "POST",
      url: "/policies/generate",
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(blocked.statusCode).toBe(403);

    // With token -> 201
    const tokenRes = await app.inject({ method: "GET", url: "/csrf-token" });
    const { csrfToken } = tokenRes.json();

    const allowed = await app.inject({
      method: "POST",
      url: "/policies/generate",
      headers: { "x-csrf-token": csrfToken },
      payload: { definition: spendingPolicy, network: "testnet" },
    });
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });
});

