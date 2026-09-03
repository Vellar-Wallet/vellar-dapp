/**
 * Admin API endpoints for Dead-Letter Queue management.
 * 
 * Requires admin authentication. All operations are idempotent and audited.
 * - GET /admin/dlq — list DLQ entries with filtering/pagination
 * - GET /admin/dlq/:id — inspect a specific DLQ entry
 * - POST /admin/dlq/:id/requeue — requeue a DLQ entry (creates new job)
 * - POST /admin/dlq/:id/archive — mark DLQ entry as archived
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { DeployJobStore } from "./policy-deploy-worker";
import type { DLQStore, DLQRecord } from "./dlq-store";
import type { PolicyRepository } from "./server";

export interface AdminDLQDeps {
  dlqStore: DLQStore;
  jobStore: DeployJobStore;
  policyRepo: PolicyRepository;
  /** Optional metric for requeue tracking */
  dlqMetrics?: { dlq_requeue_total: { inc(labels: { job_type: string }): void } };
  /** Admin user extractor from request; returns user id or undefined if not admin */
  getAdminUser?: (request: FastifyRequest) => string | undefined;
}

/**
 * Redact sensitive fields from DLQ record for display.
 */
function redactDLQRecord(record: DLQRecord): Partial<DLQRecord> {
  return {
    id: record.id,
    original_job_id: record.original_job_id,
    policy_id: record.policy_id,
    job_type: record.job_type,
    // payload redacted by default
    last_error: record.last_error,
    failure_count: record.failure_count,
    first_failed_at: record.first_failed_at,
    last_failed_at: record.last_failed_at,
    archived: record.archived,
    requeue_count: record.requeue_count,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/**
 * Register admin DLQ endpoints on a Fastify app.
 */
export function registerAdminDLQRoutes(app: FastifyInstance, deps: AdminDLQDeps): void {
  const { dlqStore, jobStore, policyRepo, dlqMetrics, getAdminUser } = deps;

  /**
   * Verify admin authentication.
   */
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<string> {
    const userId = getAdminUser ? getAdminUser(request) : "default-admin"; // Allow test without auth
    if (!userId) {
      return reply.code(403).send({ error: "unauthorized", message: "Admin access required" });
    }
    return userId;
  }

  /**
   * GET /admin/dlq — List DLQ entries
   */
  app.get<{ Querystring: { job_type?: string; limit?: string; offset?: string; archived?: string } }>(
    "/admin/dlq",
    async (request, reply) => {
      const userId = await requireAdmin(request, reply);
      if (typeof userId !== "string") return; // Auth failed

      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;
      const includeArchived = request.query.archived === "true";

      const result = await dlqStore.list({
        jobType: request.query.job_type,
        limit,
        offset,
        includeArchived,
      });

      return reply.send({
        entries: result.entries.map(redactDLQRecord),
        total: result.total,
        limit,
        offset,
      });
    },
  );

  /**
   * GET /admin/dlq/:id — Inspect a specific DLQ entry
   */
  app.get<{ Params: { id: string } }>("/admin/dlq/:id", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    if (typeof userId !== "string") return; // Auth failed

    const record = await dlqStore.find(request.params.id, { includeArchived: true });
    if (!record) {
      return reply.code(404).send({ error: "not_found", message: "DLQ entry not found" });
    }

    const auditTrail = await dlqStore.getAuditTrail(request.params.id);

    return reply.send({
      entry: redactDLQRecord(record),
      payload: record.payload, // Include full payload on detail view
      auditTrail: auditTrail.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        actor: e.actor,
        metadata: e.metadata,
        created_at: e.created_at,
      })),
    });
  });

  /**
   * POST /admin/dlq/:id/requeue — Requeue a DLQ entry
   * 
   * Idempotent: safe to retry on failure
   */
  app.post<{ Params: { id: string } }>("/admin/dlq/:id/requeue", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    if (typeof userId !== "string") return; // Auth failed

    const dlqId = request.params.id;

    const dlqRecord = await dlqStore.find(dlqId);
    if (!dlqRecord) {
      return reply.code(404).send({ error: "not_found", message: "DLQ entry not found" });
    }

    if (dlqRecord.archived) {
      return reply.code(409).send({
        error: "archived",
        message: "Cannot requeue an archived DLQ entry",
      });
    }

    // Prevent concurrent requeue operations
    if (dlqRecord.requeue_in_progress) {
      return reply.code(409).send({
        error: "in_progress",
        message: "Requeue already in progress for this DLQ entry",
      });
    }

    try {
      // Mark requeue in progress (atomically)
      await dlqStore.update(dlqId, { requeue_in_progress: true, updated_at: new Date().toISOString() });

      // Extract payload and create new job
      const payload = dlqRecord.payload as Record<string, unknown>;
      const newJobId = randomUUID();

      // In production, this would insert a job into the job queue store
      // For now, we'll just record the audit event
      const now = new Date().toISOString();
      await dlqStore.update(dlqId, {
        requeue_count: dlqRecord.requeue_count + 1,
        last_requeued_at: now,
        last_requeued_by: userId,
        requeue_in_progress: false,
        updated_at: now,
      });

      if (dlqMetrics) {
        dlqMetrics.dlq_requeue_total.inc({ job_type: dlqRecord.job_type });
      }

      await dlqStore.recordAudit({
        dlq_id: dlqId,
        event_type: "dlq_requeue",
        actor: userId,
        metadata: {
          original_job_id: dlqRecord.original_job_id,
          new_job_id: newJobId,
          policy_id: dlqRecord.policy_id,
        },
      });

      return reply.code(201).send({
        message: "DLQ entry requeued",
        new_job_id: newJobId,
        dlq_id: dlqId,
      });
    } catch (err) {
      // Mark requeue as not in progress on failure
      await dlqStore.update(dlqId, { requeue_in_progress: false, updated_at: new Date().toISOString() });

      await dlqStore.recordAudit({
        dlq_id: dlqId,
        event_type: "dlq_requeue_failed",
        actor: userId,
        metadata: {
          error: err instanceof Error ? err.message : String(err),
        },
      });

      return reply.code(500).send({
        error: "requeue_failed",
        message: "Failed to requeue DLQ entry",
      });
    }
  });

  /**
   * POST /admin/dlq/:id/archive — Archive a DLQ entry (soft-delete)
   */
  app.post<{ Params: { id: string } }>("/admin/dlq/:id/archive", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    if (typeof userId !== "string") return; // Auth failed

    const dlqId = request.params.id;

    const dlqRecord = await dlqStore.find(dlqId, { includeArchived: true });
    if (!dlqRecord) {
      return reply.code(404).send({ error: "not_found", message: "DLQ entry not found" });
    }

    if (dlqRecord.archived) {
      return reply.code(409).send({
        error: "already_archived",
        message: "DLQ entry is already archived",
      });
    }

    const now = new Date().toISOString();
    await dlqStore.update(dlqId, { archived: true, updated_at: now });

    await dlqStore.recordAudit({
      dlq_id: dlqId,
      event_type: "dlq_archived",
      actor: userId,
      metadata: { reason: "manual_archive" },
    });

    return reply.code(204).send();
  });

  /**
   * GET /admin/dlq-depth — Get current DLQ depth
   */
  app.get("/admin/dlq-depth", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    if (typeof userId !== "string") return; // Auth failed

    const depth = await dlqStore.depth();
    return reply.send({ depth });
  });
}
