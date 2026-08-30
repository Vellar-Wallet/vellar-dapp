import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerAdminDLQRoutes } from "./admin-dlq";
import { createMemoryDLQStore } from "./dlq-store";
import { InMemoryDeployJobStore, MAX_RETRIES } from "./policy-deploy-worker";
import { createMemoryPolicyRepository } from "./server";
import type { DLQMetrics } from "./policy-deploy-worker";

describe("Admin DLQ API", () => {
  let app: FastifyInstance;
  let dlqStore = createMemoryDLQStore();
  let jobStore = new InMemoryDeployJobStore();
  let policyRepo = createMemoryPolicyRepository();
  let dlqMetrics: DLQMetrics;

  beforeEach(async () => {
    app = Fastify();
    dlqStore = createMemoryDLQStore();
    jobStore = new InMemoryDeployJobStore();
    policyRepo = createMemoryPolicyRepository();

    dlqMetrics = {
      dlq_enqueue_total: { inc: vi.fn() },
      dlq_depth_gauge: { set: vi.fn() },
    };

    registerAdminDLQRoutes(app, {
      dlqStore,
      jobStore,
      policyRepo,
      dlqMetrics,
      getAdminUser: () => "admin-user-1",
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /admin/dlq", () => {
    it("returns empty list when no DLQ entries exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("lists DLQ entries with pagination", async () => {
      // Create 3 DLQ entries
      for (let i = 0; i < 3; i++) {
        await dlqStore.insert({
          original_job_id: `job-${i}`,
          policy_id: `policy-${i}`,
          job_type: "policy_deploy",
          payload: { test: true },
          last_error: `Error ${i}`,
          failure_count: MAX_RETRIES + 1,
          first_failed_at: new Date().toISOString(),
          last_failed_at: new Date().toISOString(),
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq?limit=2&offset=0",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("filters by job_type", async () => {
      await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 1,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq?job_type=policy_deploy",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(1);
    });

    it("excludes archived entries by default", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 1,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await dlqStore.update(entry.id, { archived: true });

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(0);
    });

    it("includes archived entries when requested", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 1,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await dlqStore.update(entry.id, { archived: true });

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq?archived=true",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(1);
    });
  });

  describe("GET /admin/dlq/:id", () => {
    it("returns 404 for non-existent entry", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq/nonexistent",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("returns entry with full payload and audit trail", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: { wallet: "CWALLET", network: "testnet" },
        last_error: "Deployment failed",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await dlqStore.recordAudit({
        dlq_id: entry.id,
        event_type: "dlq_move",
        metadata: { reason: "max retries exceeded" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/admin/dlq/${entry.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entry.id).toBe(entry.id);
      expect(body.payload).toEqual(entry.payload); // Full payload included
      expect(body.auditTrail).toHaveLength(1);
      expect(body.auditTrail[0].event_type).toBe("dlq_move");
    });
  });

  describe("POST /admin/dlq/:id/requeue", () => {
    it("returns 404 for non-existent entry", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/dlq/nonexistent/requeue",
      });

      expect(res.statusCode).toBe(404);
    });

    it("requeues a DLQ entry successfully", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: { wallet: "CWALLET", network: "testnet" },
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      const res = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.new_job_id).toBeDefined();
      expect(body.dlq_id).toBe(entry.id);

      // Verify requeue_count incremented
      const updated = await dlqStore.find(entry.id);
      expect(updated?.requeue_count).toBe(1);

      // Verify audit trail
      const auditTrail = await dlqStore.getAuditTrail(entry.id);
      const requeueEvent = auditTrail.find((e) => e.event_type === "dlq_requeue");
      expect(requeueEvent).toBeDefined();
      expect(requeueEvent?.actor).toBe("admin-user-1");
    });

    it("returns 409 when requeue is already in progress", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      // Mark requeue as in progress
      await dlqStore.update(entry.id, { requeue_in_progress: true });

      const res = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("in_progress");
    });

    it("returns 409 when requeuing archived entry", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await dlqStore.update(entry.id, { archived: true });

      const res = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("archived");
    });

    it("is idempotent: requeue succeeds if entry is not in progress", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      const res1 = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(res1.statusCode).toBe(201);

      // Second requeue should also succeed
      const res2 = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(res2.statusCode).toBe(201);

      const updated = await dlqStore.find(entry.id);
      expect(updated?.requeue_count).toBe(2);
    });

    it("increments dlq_requeue_total metric", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/requeue`,
      });

      expect(dlqMetrics.dlq_requeue_total.inc).toHaveBeenCalledWith({
        job_type: "policy_deploy",
      });
    });
  });

  describe("POST /admin/dlq/:id/archive", () => {
    it("archives a DLQ entry", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      const res = await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/archive`,
      });

      expect(res.statusCode).toBe(204);

      const updated = await dlqStore.find(entry.id, { includeArchived: true });
      expect(updated?.archived).toBe(true);

      // Should not appear in list by default
      const list = await dlqStore.list();
      expect(list.entries).toHaveLength(0);
    });

    it("records archive audit event", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await app.inject({
        method: "POST",
        url: `/admin/dlq/${entry.id}/archive`,
      });

      const auditTrail = await dlqStore.getAuditTrail(entry.id);
      const archiveEvent = auditTrail.find((e) => e.event_type === "dlq_archived");
      expect(archiveEvent).toBeDefined();
      expect(archiveEvent?.actor).toBe("admin-user-1");
    });
  });

  describe("GET /admin/dlq-depth", () => {
    it("returns current DLQ depth", async () => {
      for (let i = 0; i < 3; i++) {
        await dlqStore.insert({
          original_job_id: `job-${i}`,
          policy_id: `policy-${i}`,
          job_type: "policy_deploy",
          payload: {},
          last_error: "Error",
          failure_count: 6,
          first_failed_at: new Date().toISOString(),
          last_failed_at: new Date().toISOString(),
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq-depth",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().depth).toBe(3);
    });

    it("excludes archived entries from depth", async () => {
      const entry = await dlqStore.insert({
        original_job_id: "job-1",
        policy_id: "policy-1",
        job_type: "policy_deploy",
        payload: {},
        last_error: "Error",
        failure_count: 6,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });

      await dlqStore.update(entry.id, { archived: true });

      const res = await app.inject({
        method: "GET",
        url: "/admin/dlq-depth",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().depth).toBe(0);
    });
  });

  describe("Authentication", () => {
    it("denies access without admin user", async () => {
      const appNoAuth = Fastify();

      registerAdminDLQRoutes(appNoAuth, {
        dlqStore,
        jobStore,
        policyRepo,
        getAdminUser: () => undefined, // No admin
      });

      await appNoAuth.ready();

      const res = await appNoAuth.inject({
        method: "GET",
        url: "/admin/dlq",
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("unauthorized");

      await appNoAuth.close();
    });
  });
});
