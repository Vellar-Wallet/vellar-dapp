import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerHealth } from "@vela/service-kit";
import { buildCleanupSteps, buildMergeStep } from "./builder";
import type { AccountReader } from "./horizon";
import { buildCleanupPlan, isClassicAccountId } from "./planner";

// Lifecycle API (idea.md §11): inspect + plan. Execute/merge land with the
// signing-flow decision (see BUILD-PLAN — docs are ambiguous on who signs
// classic-account cleanup transactions in a passkey wallet).

const inspectBodySchema = z.object({
  accountId: z.string().min(1),
});

const planBodySchema = z.object({
  accountId: z.string().min(1),
  destination: z.string().min(1),
});

export interface LifecycleServiceDeps {
  reader: AccountReader;
  networkPassphrase?: string;
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function validatePair(accountId: string, destination: string): string | undefined {
  if (!isClassicAccountId(accountId)) return "not_classic_account";
  if (!isClassicAccountId(destination)) return "invalid_destination";
  if (destination === accountId) return "invalid_destination";
  return undefined;
}

export function buildServer(deps: LifecycleServiceDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealth(app, "lifecycle-service");

  app.post("/lifecycle/inspect", async (request, reply) => {
    const parsed = inspectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });
    return reply.send({ account });
  });

  app.post("/lifecycle/plan", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }
    if (!isClassicAccountId(destination)) {
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Merge destination must be a classic (G...) account",
      });
    }
    if (destination === accountId) {
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Destination must differ from the account being closed",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });
    return reply.send({ plan: buildCleanupPlan(account, destination) });
  });

  const passphrase = deps.networkPassphrase ?? TESTNET_PASSPHRASE;

  // Builds UNSIGNED cleanup transactions (decisions.md option A): the user
  // signs them in the wallet that holds the old account's key.
  app.post("/lifecycle/execute", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    const invalid = validatePair(accountId, destination);
    if (invalid) return reply.code(400).send({ error: invalid });

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });

    return reply.send({
      steps: buildCleanupSteps(account, destination, passphrase),
      plan: buildCleanupPlan(account, destination),
    });
  });

  // MergePreflightValidator (idea.md §6.4): re-inspects and refuses to build
  // the merge while any blocker remains.
  app.post("/lifecycle/merge", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    const invalid = validatePair(accountId, destination);
    if (invalid) return reply.code(400).send({ error: invalid });

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });

    const plan = buildCleanupPlan(account, destination);
    if (!plan.mergeReady) {
      return reply.code(409).send({ error: "not_merge_ready", plan });
    }
    return reply.send({ step: buildMergeStep(account, destination, passphrase) });
  });

  return app;
}
