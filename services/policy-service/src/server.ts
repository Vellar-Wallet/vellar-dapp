import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerHealth, registerMetrics, domainMetrics, recordOutcome } from "@vela/service-kit";
import type { PolicyDefinition } from "@vela/types";
import { PolicyDeployError, type PolicyDeployer } from "./deploy";
import { generatePolicy, templates, validateDefinition, type GeneratedPolicy } from "./templates";

// Policy API (idea.md §11): validate → generate → (review) → deploy.
// Generated policies persist for review/deploy (idea.md §9 policies table —
// in-memory behind an interface for now, Postgres follows the wallet-service
// pattern before the V1 gate).

export interface PolicyRecord extends GeneratedPolicy {
  id: string;
  createdAt: string;
  status: "generated" | "instance_deployed" | "deployed";
  /** The policy contract instance deployed for this policy (spending limits).
   * Set by /deploy-instance before the wallet attaches it. */
  instance?: { contractId: string; txHash: string; deployedAt: string };
  /** The completed attach (kit.addPolicy), recorded after the passkey signs. */
  deployment?: { contractId?: string; txHash: string; deployedAt: string };
}

export interface PolicyRepository {
  insert(record: PolicyRecord): Promise<void>;
  find(id: string): Promise<PolicyRecord | undefined>;
  update(record: PolicyRecord): Promise<void>;
}

export function createMemoryPolicyRepository(): PolicyRepository {
  const records = new Map<string, PolicyRecord>();
  return {
    async insert(record) {
      records.set(record.id, record);
    },
    async find(id) {
      return records.get(id);
    },
    async update(record) {
      records.set(record.id, record);
    },
  };
}

const networkSchema = z.enum(["testnet", "mainnet"]);

const generateBodySchema = z.object({
  definition: z.unknown(),
  network: networkSchema,
});

const deployBodySchema = z.object({
  policyId: z.string().min(1),
  /** Hash of the on-chain attach (kit.addPolicy) transaction, passkey-signed client-side. */
  txHash: z.string().min(1),
  contractId: z.string().optional(),
});

const walletAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a smart-account address (C…)");

const deployInstanceBodySchema = z.object({
  /** The user's smart-account the policy instance is bound to. */
  wallet: walletAddress,
});

export interface PolicyServiceDeps {
  policies?: PolicyRepository;
  now?: () => Date;
  /** Deploys per-user policy contract instances server-side (sponsor-funded).
   * undefined = /deploy-instance returns 503 (no sponsor configured). */
  deployer?: PolicyDeployer;
}

export function buildServer(deps: PolicyServiceDeps = {}): FastifyInstance {
  const policies = deps.policies ?? createMemoryPolicyRepository();
  const now = deps.now ?? (() => new Date());
  const deployer = deps.deployer;

  const app = Fastify({ logger: true });
  registerHealth(app, "policy-service");
  registerMetrics(app, "policy-service");

  app.get("/policies/templates", async () =>
    templates.map(({ type, title, description, enforcement }) => ({
      type,
      title,
      description,
      enforcement,
    })),
  );

  app.post("/policies/validate", async (request, reply) => {
    return reply.send(validateDefinition(request.body));
  });

  app.post("/policies/generate", async (request, reply) => {
    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const validation = validateDefinition(parsed.data.definition);
    if (!validation.valid) {
      return reply.code(422).send({ error: "invalid_policy", errors: validation.errors });
    }

    const generated = generatePolicy(
      parsed.data.definition as PolicyDefinition,
      parsed.data.network,
    );
    const record: PolicyRecord = {
      id: randomUUID(),
      createdAt: now().toISOString(),
      status: "generated",
      ...generated,
    };
    await policies.insert(record);
    return reply.code(201).send({ policy: record });
  });

  // Dry-run the instance deploy (build + simulate, no submit) so the UI can
  // confirm the deploy will succeed and show the resource cost before the user
  // commits. Same constructor args the real deploy will use.
  app.post("/policies/:id/simulate", async (request, reply) => {
    if (!deployer) {
      return reply.code(503).send({ error: "deploy_unavailable", reason: "no sponsor configured" });
    }
    const { id } = request.params as { id: string };
    const parsed = deployInstanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });

    const enforcement = record.manifest.enforcement;
    if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
      return reply.code(422).send({
        error: "not_deployable",
        reason: "this policy is enforced without a deployed contract instance",
      });
    }

    const result = await deployer.simulateInstance({
      wallet: parsed.data.wallet,
      dailyLimitStroops: enforcement.constructorArgs.dailyLimitStroops,
      windowSeconds: enforcement.constructorArgs.windowSeconds,
    });
    return reply.send(result);
  });

  // Deploys the per-user policy contract instance server-side (sponsor-funded),
  // bound to the caller's smart-account. This is step 1 of the two-step attach:
  // the returned contractId is then attached by the wallet via a passkey-signed
  // kit.addPolicy (step 2), which the client records via POST /policies/deploy.
  // No keys touch the wallet here — the instance is inert until attached.
  app.post("/policies/:id/deploy-instance", async (request, reply) => {
    if (!deployer) {
      return reply.code(503).send({ error: "deploy_unavailable", reason: "no sponsor configured" });
    }
    const { id } = request.params as { id: string };
    const parsed = deployInstanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });
    if (record.instance) {
      // Idempotent-ish: an instance already exists for this policy. Return it
      // rather than spending another deploy.
      return reply.send({ policy: record, contractId: record.instance.contractId });
    }

    const enforcement = record.manifest.enforcement;
    if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
      return reply.code(422).send({
        error: "not_deployable",
        reason: "this policy is enforced without a deployed contract instance",
      });
    }

    let result: { contractId: string; txHash: string };
    try {
      result = await deployer.deployInstance({
        wallet: parsed.data.wallet,
        dailyLimitStroops: enforcement.constructorArgs.dailyLimitStroops,
        windowSeconds: enforcement.constructorArgs.windowSeconds,
      });
    } catch (err) {
      if (err instanceof PolicyDeployError) {
        request.log.error({ err, policyId: id }, "policy instance deploy failed");
        recordOutcome(domainMetrics.policyDeployed, "policy-service", "failure");
        return reply.code(502).send({ error: "deploy_failed", code: err.code });
      }
      throw err;
    }

    record.status = "instance_deployed";
    record.instance = { ...result, deployedAt: now().toISOString() };
    await policies.update(record);
    recordOutcome(domainMetrics.policyDeployed, "policy-service", "success");
    return reply.send({ policy: record, contractId: result.contractId });
  });

  // Records a completed attach (kit.addPolicy is built and passkey-signed
  // client-side — the service never holds keys).
  app.post("/policies/deploy", async (request, reply) => {
    const parsed = deployBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const record = await policies.find(parsed.data.policyId);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });

    record.status = "deployed";
    record.deployment = {
      contractId: parsed.data.contractId,
      txHash: parsed.data.txHash,
      deployedAt: now().toISOString(),
    };
    await policies.update(record);
    return reply.send({ policy: record });
  });

  app.get("/policies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });
    return reply.send({ policy: record });
  });

  return app;
}
