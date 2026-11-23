import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  registerHealth,
  registerMetrics,
  domainMetrics,
  recordOutcome,
  extractTraceContext,
  withTraceSpan,
  logEvent,
  type SpendBudget,
  type BudgetNetwork,
  registerTracing,
} from "@vellar/service-kit";
import type { PolicyDefinition } from "@vellar/types";
import { PolicyDeployError, type PolicyDeployer } from "./deploy";
import { generatePolicy, templates, type GeneratedPolicy } from "./templates";
import { AttachMismatchError, AttachUnconfirmedError, type TxLookup } from "./verify-attach";
import { createCsrfPreHandler, generateCsrfToken } from "./csrf";
import {
  deployBodySchema,
  deployInstanceBodySchema,
  generateBodySchema,
  validateDefinition,
  validatePolicyForDeployment,
  validatePolicyInstance,
} from "./validation";
import {
  deployPolicyInstance,
  simulatePolicyDeploy,
  verifyAndRecordAttach,
  type DeploymentDeps,
} from "./deployment";
import { registerAdminDLQRoutes } from "./admin-dlq";
import type { DLQStore } from "./dlq-store";
import type { DeployJobStore, DLQMetrics } from "./policy-deploy-worker";

// Policy API (idea.md §11): validate → generate → (review) → deploy.
// Generated policies persist for review/deploy (idea.md §9 policies table —
// in-memory behind an interface for now, Postgres follows the wallet-service
// pattern before the V1 gate).

export interface PolicyRecord extends GeneratedPolicy {
  id: string;
  createdAt: string;
  status: "generated" | "instance_deployed" | "deployed";
  /** The policy contract instance deployed for this policy (spending limits).
   * Set by /deploy-instance before the wallet attaches it. `wallet` is the
   * smart-account it is bound to — needed to verify the attach tx (L1). */
  instance?: { contractId: string; wallet: string; txHash: string; deployedAt: string };
  /** The completed attach (kit.addPolicy), recorded after the passkey signs. */
  deployment?: { contractId?: string; txHash: string; deployedAt: string };
}

/** Opaque pagination cursor for PolicyRepository.listPage (issue #257):
 * callers pass back a previous page's nextCursor verbatim. */
export type PolicyCursor = string;

export interface PolicyPage {
  policies: PolicyRecord[];
  hasMore: boolean;
  /** Present iff hasMore; pass to the next call's `after` filter. */
  nextCursor?: PolicyCursor;
}

export interface PolicyListFilter {
  /** Real status vocabulary (see PolicyRecord.status): "generated",
   * "instance_deployed", or "deployed". Issue #257 named "active"/"draft"/
   * "revoked" as examples, but those values do not exist anywhere in this
   * codebase's actual status lifecycle (see docs/decisions.md) — this
   * filters on the real values, not the issue's stale examples. */
  status?: PolicyRecord["status"];
  /** Inclusive lower bound on createdAt (ISO 8601). */
  createdAfter?: string;
  /** Inclusive upper bound on createdAt (ISO 8601). */
  createdBefore?: string;
  limit: number;
  after?: PolicyCursor;
}

export interface PolicyRepository {
  insert(record: PolicyRecord): Promise<void>;
  find(id: string): Promise<PolicyRecord | undefined>;
  update(record: PolicyRecord): Promise<void>;
  /** Cursor-paginated, newest-first list (issue #257). */
  listPage(filter: PolicyListFilter): Promise<PolicyPage>;
}

/** Encodes a (createdAt, id) keyset position as an opaque cursor token.
 * Exported for reuse by createPgPolicyRepository, which needs the same
 * encoding for its SQL keyset query to interoperate with a cursor produced
 * by either implementation. */
export function encodePolicyCursor(createdAt: string, id: string): PolicyCursor {
  return Buffer.from(`${createdAt}:${id}`, "utf8").toString("base64url");
}

export function decodePolicyCursor(cursor: PolicyCursor): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error("malformed policy cursor");
  }
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
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
    async listPage(filter) {
      let filtered = [...records.values()];
      if (filter.status) filtered = filtered.filter((r) => r.status === filter.status);
      if (filter.createdAfter) filtered = filtered.filter((r) => r.createdAt >= filter.createdAfter!);
      if (filter.createdBefore) filtered = filtered.filter((r) => r.createdAt <= filter.createdBefore!);

      // Newest first: (createdAt, id) descending — id is the tiebreaker for a
      // shared createdAt, same reasoning as wallet-service's activity log
      // pagination (see repository.ts there): createdAt alone is not a total
      // order, so a page boundary landing on a tie could skip or repeat a row.
      filtered.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

      if (filter.after) {
        const decoded = decodePolicyCursor(filter.after);
        filtered = filtered.filter((r) => {
          if (r.createdAt !== decoded.createdAt) return r.createdAt < decoded.createdAt;
          return r.id < decoded.id;
        });
      }

      const hasMore = filtered.length > filter.limit;
      const page = hasMore ? filtered.slice(0, filter.limit) : filtered;
      const last = page[page.length - 1];
      return {
        policies: page,
        hasMore,
        nextCursor: hasMore && last ? encodePolicyCursor(last.createdAt, last.id) : undefined,
      };
    },
  };
}

export interface PolicyServiceDeps {
  policies?: PolicyRepository;
  now?: () => Date;
  /** Deploys per-user policy contract instances server-side (sponsor-funded).
   * undefined = /deploy-instance returns 503 (no sponsor configured). */
  deployer?: PolicyDeployer;
  /** Readiness probe for DB-aware /health (FIX 7). */
  isReady?: () => boolean | Promise<boolean>;
  /** Rolling-window spend budget for the "deploy" line (FIX 3). Consumed before
   * a sponsor-funded deploy; a refusal returns 503. Unset = disabled. */
  budget?: SpendBudget;
  /** Network label for budget accounting — from server config, never a request
   * body (V5). Required when budget is set. */
  budgetNetwork?: BudgetNetwork;
  /** RPC tx lookup for L1 attach verification, bound to the server-config
   * network's RPC. When set, /policies/deploy verifies the attach tx before
   * stamping 'deployed'. Unset = verification disabled (dev/no-rpc). */
  verifyAttach?: TxLookup;
  /** Network label for the attach verification (server config, never the
   * request body — V5). Defaults to "testnet". */
  network?: BudgetNetwork;
  /** Passphrase used to decode the attach tx envelope. Defaults to testnet. */
  networkPassphrase?: string;
  /** Secret used to sign and verify CSRF tokens. Default used when unset. */
  csrfSecret?: string;
  /** Fastify logger configuration. Defaults to `true` (JSON lines on stdout at
   * info level). Tests pass `{ level: "debug", stream }` to capture and inspect
   * everything the server logs (e.g. that no secret is ever written, #755). */
  logger?: FastifyServerOptions["logger"];
  /** Token TTL in milliseconds. Defaults to 3600_000 (1 hour). */
  csrfTtlMs?: number;
  /** When true, enforces CSRF token validation on all state-changing endpoints. */
  enableCsrf?: boolean;
  /** DLQ store for dead-letter queue operations. */
  dlqStore?: DLQStore;
  /** Deploy job store for job requeue operations. */
  jobStore?: DeployJobStore;
  /** DLQ metrics for tracking requeues. */
  dlqMetrics?: Pick<DLQMetrics, "dlq_requeue_total">;
  /** Admin user extractor. */
  getAdminUser?: (request: FastifyRequest) => string | undefined;
}

export function buildServer(deps: PolicyServiceDeps = {}): FastifyInstance {
  const policies = deps.policies ?? createMemoryPolicyRepository();
  const now = deps.now ?? (() => new Date());
  const deployer = deps.deployer;
  const verifyAttach = deps.verifyAttach;
  const network = deps.network ?? "testnet";
  const networkPassphrase = deps.networkPassphrase ?? "Test SDF Network ; September 2015";
  const csrfSecret =
    deps.csrfSecret ?? process.env.CSRF_SECRET ?? "vellar-policy-admin-csrf-default-secret";

  const deploymentDeps: DeploymentDeps = {
    policies,
    deployer,
    verifyAttach,
    budget: deps.budget,
    budgetNetwork: deps.budgetNetwork,
    network,
    networkPassphrase,
    now,
  };

  const app = Fastify({ logger: deps.logger ?? true });
  registerTracing(app, "policy-service");
  registerHealth(app, "policy-service", { isReady: deps.isReady });
  registerMetrics(app, "policy-service");

  if (deps.dlqStore && deps.jobStore) {
    // getAdminUser is required by registerAdminDLQRoutes; omitting it throws at boot
    // instead of attributing admin actions to a shared default identity.
    registerAdminDLQRoutes(app, {
      dlqStore: deps.dlqStore,
      jobStore: deps.jobStore,
      policyRepo: policies,
      dlqMetrics: deps.dlqMetrics,
      getAdminUser: deps.getAdminUser as NonNullable<typeof deps.getAdminUser>,
    });
  }

  const csrfPreHandler = createCsrfPreHandler({
    secret: csrfSecret,
    ttlMs: deps.csrfTtlMs,
  });

  // Enforce CSRF token validation on state-changing admin routes (/admin/*) or all mutations if enableCsrf is true
  app.addHook("preHandler", async (request, reply) => {
    const url = (request.routeOptions?.url ?? request.url).split("?")[0] ?? "";
    if (url.startsWith("/admin") || url.startsWith("/policies/admin") || deps.enableCsrf) {
      await csrfPreHandler(request, reply);
    }
  });

  // CSRF token endpoints (Issue #311)
  const getCsrfTokenHandler = async () => ({
    csrfToken: generateCsrfToken(csrfSecret),
  });
  app.get("/admin/csrf-token", getCsrfTokenHandler);
  app.get("/policies/admin/csrf-token", getCsrfTokenHandler);
  app.get("/csrf-token", getCsrfTokenHandler);

  app.get("/policies/templates", async () =>
    templates.map(({ type, schemaVersion, title, description, enforcement }) => ({
      type,
      schemaVersion,
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

  // Batch endpoint for submitting multiple policy templates (#261)
  const MAX_BATCH_SIZE = 50;
  app.post("/policies/batch", async (request, reply) => {
    const body = request.body as { templates?: Array<{ definition?: unknown; network?: string }> };
    if (!body || !Array.isArray(body.templates) || body.templates.length === 0) {
      return reply.code(400).send({ error: "invalid_body", message: "Expected a non-empty templates array" });
    }

    if (body.templates.length > MAX_BATCH_SIZE) {
      return reply.code(400).send({
        error: "batch_size_exceeded",
        message: `Maximum batch size is ${MAX_BATCH_SIZE}`,
      });
    }

    const results = await Promise.all(
      body.templates.map(async (item, index) => {
        const validation = validateDefinition(item.definition);
        if (!validation.valid) {
          return {
            index,
            success: false,
            error: "invalid_policy",
            details: validation.errors,
          };
        }

        try {
          const generated = generatePolicy(
            item.definition as PolicyDefinition,
            (item.network as "testnet" | "mainnet") ?? "testnet",
          );
          const record: PolicyRecord = {
            id: randomUUID(),
            createdAt: now().toISOString(),
            status: "generated",
            ...generated,
          };
          await policies.insert(record);
          return {
            index,
            success: true,
            policy: record,
          };
        } catch (err) {
          return {
            index,
            success: false,
            error: err instanceof Error ? err.message : "generation_failed",
          };
        }
      })
    );

    const hasFailures = results.some((r) => !r.success);
    return reply.code(hasFailures ? 207 : 200).send({
      total: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  });


  // Dry-run the instance deploy (build + simulate, no submit) so the UI can
  // confirm the deploy will succeed and show the resource cost before the user
  // commits. Same constructor args the real deploy will use.
  app.post("/policies/:id/simulate", async (request, reply) => {
    if (!deps.deployer) {
      return reply.code(503).send({ error: "deploy_unavailable", reason: "no sponsor configured" });
    }
    const { id } = request.params as { id: string };
    const parsed = deployInstanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });

    const deployCheck = validatePolicyForDeployment(record);
    if (!deployCheck.valid) {
      return reply.code(422).send({
        error: "not_deployable",
        reason: deployCheck.error,
      });
    }

    try {
      const result = await simulatePolicyDeploy(deploymentDeps, record, parsed.data.wallet);
      return reply.send(result);
    } catch (err) {
      request.log.error(err, "simulate failed");
      return reply.code(500).send({ error: "simulate_failed" });
    }
  });

  // Deploys the per-user policy contract instance server-side (sponsor-funded),
  // bound to the caller's smart-account. This is step 1 of the two-step attach:
  // the returned contractId is then attached by the wallet via a passkey-signed
  // kit.addPolicy (step 2), which the client records via POST /policies/deploy.
  // No keys touch the wallet here — the instance is inert until attached.
  app.post("/policies/:id/deploy-instance", async (request, reply) => {
    if (!deps.deployer) {
      return reply.code(503).send({ error: "deploy_unavailable", reason: "no sponsor configured" });
    }
    const { id } = request.params as { id: string };
    const parsed = deployInstanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });

    // Idempotent-ish: an instance already exists for this policy. Return it
    // rather than spending another deploy.
    if (record.instance) {
      return reply.send({ policy: record, contractId: record.instance.contractId });
    }

    const deployCheck = validatePolicyForDeployment(record);
    if (!deployCheck.valid) {
      return reply.code(422).send({
        error: "not_deployable",
        reason: deployCheck.error,
      });
    }

    try {
      // #301: the sponsor-funded deploy is the slow, failure-prone hop — give it
      // its own span under this request's server span.
      const { record: updated, contractId } = await withTraceSpan(
        "policy-service",
        "policy.deploy-instance",
        request.traceContext ?? extractTraceContext(request.headers),
        () => deployPolicyInstance(deploymentDeps, record, parsed.data.wallet),
        { policyId: id },
      );
      return reply.send({ policy: updated, contractId });
    } catch (err) {
      if (err instanceof PolicyDeployError) {
        request.log.error({ err, policyId: id }, "policy instance deploy failed");
        return reply.code(502).send({ error: "deploy_failed", code: err.code });
      }
      if (err instanceof Error && err.message === "deploy_budget_exceeded") {
        request.log.error({ policyId: id }, "deploy budget exceeded");
        return reply.code(503).send({
          error: "deploy_budget_exceeded",
          message: "Policy-deploy budget reached; try again later.",
        });
      }
      // Any other failure (e.g. an RPC error the deployer didn't wrap) MUST
      // still answer with an error status. Falling through used to resolve the
      // handler with no body — an empty 200 the client read as a successful
      // deploy with contractId undefined.
      request.log.error(err, "deploy-instance failed");
      return reply.code(500).send({ error: "deploy_failed" });
    }
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

    // Full attach verification (L1): the client-supplied txHash must actually be
    // an add_signer on THIS wallet binding THIS policy contract on-chain — not
    // merely a successful hash on the network (that is a public list). Requires
    // a deployed instance carrying the wallet + policy contract to verify against.
    if (deps.verifyAttach) {
      const instanceCheck = validatePolicyInstance(record);
      if (!instanceCheck.valid) {
        return reply.code(422).send({
          error: "no_instance",
          message: instanceCheck.error,
        });
      }
    }

    try {
      const updated = await verifyAndRecordAttach(
        deploymentDeps,
        record,
        parsed.data.txHash,
        parsed.data.contractId,
      );
      return reply.send({ policy: updated });
    } catch (err) {
      if (err instanceof AttachUnconfirmedError) {
        // Chain unreachable / tx not found — do NOT stamp; retryable.
        request.log.warn({ code: err.code, policyId: record.id }, "attach unconfirmed");
        return reply.code(503).send({ error: err.code, message: err.message });
      }
      if (err instanceof AttachMismatchError) {
        // Chain confirmed a mismatch — a lie, not a transient.
        request.log.warn({ code: err.code, policyId: record.id }, "attach mismatch");
        return reply.code(422).send({ error: err.code, message: err.message });
      }
      if (err instanceof Error && err.message === "no_instance") {
        return reply.code(422).send({
          error: "no_instance",
          message: "No deployed policy instance to verify an attach against.",
        });
      }
      throw err;
    }
  });

  const VALID_POLICY_STATUSES = new Set<PolicyRecord["status"]>([
    "generated",
    "instance_deployed",
    "deployed",
  ]);
  const POLICY_LIST_DEFAULT_LIMIT = 20;
  const POLICY_LIST_MAX_LIMIT = 100;

  // Cursor-paginated policy list with status + date-range filtering (issue
  // #257). "active"/"draft"/"revoked" from the issue's own examples do not
  // exist in this codebase's status lifecycle (see PolicyRecord.status);
  // this validates against the real values instead.
  app.get("/policies", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;

    let status: PolicyRecord["status"] | undefined;
    if (query.status !== undefined) {
      if (!VALID_POLICY_STATUSES.has(query.status as PolicyRecord["status"])) {
        return reply.code(400).send({
          error: "invalid_status",
          message: `status must be one of: ${[...VALID_POLICY_STATUSES].join(", ")}`,
        });
      }
      status = query.status as PolicyRecord["status"];
    }

    const INVALID = Symbol("invalid_date");
    const parseDateParam = (name: "created_after" | "created_before"): string | undefined | typeof INVALID => {
      const raw = query[name];
      if (raw === undefined) return undefined;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return INVALID;
      return parsed.toISOString();
    };

    const createdAfter = parseDateParam("created_after");
    if (createdAfter === INVALID) {
      return reply.code(400).send({ error: "invalid_created_after", message: "created_after must be a valid date" });
    }
    const createdBefore = parseDateParam("created_before");
    if (createdBefore === INVALID) {
      return reply
        .code(400)
        .send({ error: "invalid_created_before", message: "created_before must be a valid date" });
    }
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      return reply.code(400).send({
        error: "invalid_date_range",
        message: "created_after must not be after created_before",
      });
    }

    let limit = POLICY_LIST_DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      const parsedLimit = Number(query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return reply.code(400).send({ error: "invalid_limit", message: "limit must be a positive integer" });
      }
      limit = Math.min(parsedLimit, POLICY_LIST_MAX_LIMIT);
    }

    let page;
    try {
      page = await policies.listPage({
        status,
        createdAfter: createdAfter as string | undefined,
        createdBefore: createdBefore as string | undefined,
        limit,
        after: query.cursor,
      });
    } catch {
      return reply.code(400).send({ error: "invalid_cursor", message: "cursor is not a valid pagination cursor" });
    }
    return reply.send({
      policies: page.policies,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
    });
  });

  app.get("/policies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await policies.find(id);
    if (!record) return reply.code(404).send({ error: "policy_not_found" });
    return reply.send({ policy: record });
  });

  // Dedicated admin surface routes (Issue #311).
  // These mutate state and enforce CSRF protection via the preHandler hook.
  app.post("/admin/policies/generate", async (request, reply) => {
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

  app.post("/admin/policies/:id/deploy-instance", async (request, reply) => {
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
      const constructorArgs = enforcement.constructorArgs;
      result = await withTraceSpan(
        "policy-service",
        "policy.deploy-instance",
        request.traceContext ?? extractTraceContext(request.headers),
        () => deployer.deployInstance({ wallet: parsed.data.wallet, constructorArgs }),
        { policyId: id, admin: true },
      );
    } catch (err) {
      if (err instanceof PolicyDeployError) {
        request.log.error({ err, policyId: id }, "policy instance deploy failed");
        recordOutcome(domainMetrics.policyDeployed, "policy-service", "failure");
        return reply.code(502).send({ error: "deploy_failed", code: err.code });
      }
      throw err;
    }

    record.status = "instance_deployed";
    record.instance = { ...result, wallet: parsed.data.wallet, deployedAt: now().toISOString() };
    await policies.update(record);
    recordOutcome(domainMetrics.policyDeployed, "policy-service", "success");
    return reply.send({ policy: record, contractId: result.contractId });
  });

  app.post("/admin/policies/deploy", async (request, reply) => {
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

    // Issue #347: emit analytics event for successful policy template deployment
    logEvent(request.log, "policy.deployed", {
      policyId: record.id,
      templateType: record.definition.type,
      walletId: record.instance?.wallet,
      deployedAt: record.deployment.deployedAt,
    });

    return reply.send({ policy: record });
  });

  return app;
}

export const createPolicyService = buildServer;
