import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  logEvent,
  registerHealth,
  registerMetrics,
  domainMetrics,
  recordOutcome,
} from "@vellar/service-kit";
import { buildCleanupSteps, buildMergeStep } from "./builder";
import type { AccountReader } from "./horizon";
import { buildCleanupPlan, isClassicAccountId } from "./planner";
import type { CleanupJobStore } from "./db/job-store";

// Lifecycle API (idea.md §11): inspect + plan + async execute/merge (Issue #293).
// Execute/merge endpoints now enqueue jobs to a persistent queue, ensuring
// per-account FIFO ordering and reliable processing across worker instances.

const inspectBodySchema = z.object({
  accountId: z.string().min(1),
});

const planBodySchema = z.object({
  accountId: z.string().min(1),
  destination: z.string().min(1),
});

export interface LifecycleServiceDeps {
  reader: AccountReader;
  auditLog: AuditLog;
  networkPassphrase?: string;
  /** Injectable logger (tests). Defaults to the request-scoped logger so
   * cleanup events stay correlated with the request that produced them. */
  logger?: Pick<FastifyBaseLogger, "info">;
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
  registerMetrics(app, "lifecycle-service");

  app.post("/lifecycle/inspect", async (request, reply) => {
    const parsed = inspectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      await deps.auditLog.record("lifecycle.inspect_rejected", {
        reason: "not_classic_account",
      });
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) {
      await deps.auditLog.record("lifecycle.inspect_failed", {
        reason: "account_not_found",
      });
      return reply.code(404).send({ error: "account_not_found" });
    }

    await deps.auditLog.record("lifecycle.account_inspected", {
      account,
    });
    return reply.send({ account });
  });

  app.post("/lifecycle/plan", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      await deps.auditLog.record("lifecycle.plan_rejected", {
        reason: "not_classic_account",
      });
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }
    if (!isClassicAccountId(destination)) {
      await deps.auditLog.record("lifecycle.plan_rejected", {
        reason: "invalid_destination",
      });
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Merge destination must be a classic (G...) account",
      });
    }
    if (destination === accountId) {
      await deps.auditLog.record("lifecycle.plan_rejected", {
        reason: "invalid_destination",
      });
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Destination must differ from the account being closed",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) {
      await deps.auditLog.record("lifecycle.plan_failed", {
        reason: "account_not_found",
      });
      return reply.code(404).send({ error: "account_not_found" });
    }

    const plan = buildCleanupPlan(account, destination);
    await deps.auditLog.record("lifecycle.cleanup_planned", { plan });
    return reply.send({ plan });
  });

  const passphrase = deps.networkPassphrase ?? TESTNET_PASSPHRASE;

  // POST /lifecycle/execute — Enqueue or build cleanup operations.
  // If a job store is configured (Issue #293), enqueues the job for async processing
  // and returns a job ID. Otherwise, builds and returns unsigned XDR immediately.
  app.post("/lifecycle/execute", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    const invalid = validatePair(accountId, destination);
    if (invalid) {
      await deps.auditLog.record("lifecycle.execute_rejected", { reason: invalid });
      return reply.code(400).send({ error: invalid });
    }

    // If job store is configured, enqueue the job for async processing
    if (deps.store) {
      try {
        const { jobId, sequenceNumber } = await deps.store.enqueueJob(accountId, destination);
        return reply.code(202).send({
          jobId,
          sequenceNumber,
          status: "queued",
          message: "Cleanup job queued for processing. Poll GET /lifecycle/jobs/:jobId for status.",
        });
      } catch (err) {
        return reply.code(500).send({
          error: "enqueue_failed",
          message: err instanceof Error ? err.message : "Failed to enqueue job",
        });
      }
    }

    // Fallback: synchronous mode (no job store configured)
    const account = await deps.reader.getAccount(accountId);
    if (!account) {
      await deps.auditLog.record("lifecycle.execute_failed", {
        reason: "account_not_found",
      });
      return reply.code(404).send({ error: "account_not_found" });
    }

    const steps = buildCleanupSteps(account, destination, passphrase);
    const plan = buildCleanupPlan(account, destination);

    // Structured audit trail (issue #304): one entry per step built, so
    // operators can see exactly what a cleanup plan execution produced.
    const log = deps.logger ?? request.log;
    if (steps.length === 0) {
      logEvent(log, "cleanup.plan.executed", {
        accountId,
        destination,
        outcome: "no_steps",
      });
    } else {
      steps.forEach((step, index) => {
        logEvent(log, "cleanup.step.built", {
          accountId,
          destination,
          outcome: "built",
          stepIndex: index + 1,
          stepCount: steps.length,
          title: step.title,
          hash: step.hash,
        });
      });
    }

    return reply.send({ steps, plan });
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
    if (invalid) {
      await deps.auditLog.record("lifecycle.merge_rejected", { reason: invalid });
      return reply.code(400).send({ error: invalid });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) {
      await deps.auditLog.record("lifecycle.merge_failed", {
        reason: "account_not_found",
      });
      return reply.code(404).send({ error: "account_not_found" });
    }

    const plan = buildCleanupPlan(account, destination);
    if (!plan.mergeReady) {
      // §13 alerting: abnormal cleanup failure rates. A merge refused because
      // the account still has blockers is a "not ready" outcome, not success.
      await deps.auditLog.record("lifecycle.merge_rejected", {
        reason: "not_merge_ready",
        blockerCount: plan.blockers.length,
      });
      recordOutcome(domainMetrics.cleanupCompleted, "lifecycle-service", "failure");
      return reply.code(409).send({ error: "not_merge_ready", plan });
    }

    const step = buildMergeStep(account, destination, passphrase);
    await deps.auditLog.record("lifecycle.account_merged", { step });
    recordOutcome(domainMetrics.cleanupCompleted, "lifecycle-service", "success");
    return reply.send({ step });
  });

  return app;
}
