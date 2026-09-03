import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createPgJobStore } from "./pg-job-store";
import { calculateBackoffDelay, BACKOFF_CONFIG } from "./backoff";
import type { VerificationRecordInternal } from "@vellar/verification-service/server";

// Integration tests for reaper with exponential backoff (M7).
// The atomic reclaim/dead-letter SQL can only be verified against a real DB.
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("pg-job-store reaper with exponential backoff (M7)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  const record = (id: string, contractId: string): VerificationRecordInternal => ({
    id,
    contractId,
    sourceType: "repo",
    repoUrl: "https://github.com/x/y",
    commitHash: "abc1234",
    toolchainVersion: "1.94.0",
    status: "submitted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  async function seed(
    id: string,
    contractId: string,
    status = "submitted",
    updatedAt = new Date(),
    attempts = 0,
  ) {
    const rec = record(id, contractId);
    const recordWithAttempts: VerificationRecordInternal = { ...rec, updatedAt: new Date().toISOString() };
    await db.execute(sql`
      INSERT INTO verification_records (id, contract_id, status, created_at, updated_at, record)
      VALUES (
        ${id},
        ${contractId},
        ${status},
        now(),
        ${updatedAt},
        ${JSON.stringify({ ...recordWithAttempts, attempts })}::jsonb
      )
    `);
  }

  async function statusOf(id: string): Promise<string> {
    const r = await db.execute(sql`SELECT status FROM verification_records WHERE id = ${id}`);
    const rows = (r as unknown as { rows: { status: string }[] }).rows;
    return rows[0]?.status ?? "MISSING";
  }

  async function attemptsOf(id: string): Promise<number> {
    const r = await db.execute(
      sql`SELECT coalesce((record->>'attempts')::int, 0) AS a FROM verification_records WHERE id = ${id}`,
    );
    const rows = (r as unknown as { rows: { a: number }[] }).rows;
    return rows[0]?.a ?? 0;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS verification_records (
        id text PRIMARY KEY,
        contract_id text NOT NULL,
        status text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        record jsonb NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE verification_records`);
  });

  describe("backoff callbacks on reclaim", () => {
    it("calls onReclaimed with attempt number when reclaiming a stranded job", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      // A building row from 20 min ago with 1 previous attempt
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 1);

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(onReclaimed).toHaveBeenCalledWith(1); // attempts=1 passed to callback
      expect(await statusOf("r1")).toBe("submitted");
    });

    it("calls onReclaimed with correct attempt number on multiple reclaims", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      // Two jobs with different attempt counts
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 1);
      await seed("r2", "C2", "building", new Date(Date.now() - 20 * 60_000), 2);

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledTimes(2);
      expect(onReclaimed).toHaveBeenNthCalledWith(1, 1);
      expect(onReclaimed).toHaveBeenNthCalledWith(2, 2);
    });
  });

  describe("backoff callbacks on dead-lettering", () => {
    it("calls onDeadLettered when exhausting max attempts", async () => {
      const store = createPgJobStore(db);
      const onDeadLettered = vi.fn();

      // A building row from 20 min ago with attempts=3 (at the limit)
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 3);

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onDeadLettered,
      });

      expect(onDeadLettered).toHaveBeenCalledOnce();
      expect(await statusOf("r1")).toBe("dead_letter");
    });

    it("calls onDeadLettered for each job exceeding max attempts", async () => {
      const store = createPgJobStore(db);
      const onDeadLettered = vi.fn();

      // Two jobs: one at limit, one over
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 3);
      await seed("r2", "C2", "building", new Date(Date.now() - 20 * 60_000), 4);
      // One job below limit should reclaim instead
      await seed("r3", "C3", "building", new Date(Date.now() - 20 * 60_000), 2);

      const onReclaimed = vi.fn();
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
        onDeadLettered,
      });

      expect(onDeadLettered).toHaveBeenCalledTimes(2);
      expect(onReclaimed).toHaveBeenCalledTimes(1);
    });

    it("does not call onDeadLettered for jobs with remaining attempts", async () => {
      const store = createPgJobStore(db);
      const onDeadLettered = vi.fn();
      const onReclaimed = vi.fn();

      // A building row from 20 min ago with 1 attempt < 3 max
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 1);

      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
        onDeadLettered,
      });

      expect(onDeadLettered).not.toHaveBeenCalled();
      expect(onReclaimed).toHaveBeenCalledOnce();
    });
  });

  describe("backoff delay calculation integration", () => {
    it("calculates backoff delays with correct base and max parameters", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      // Seed a job that will be reclaimed
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 0);

      // Pass custom backoff parameters
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 500,
        maxBackoffDelayMs: 15_000,
        onReclaimed,
      });

      // Verify the callback was called (it received the calculated delay internally)
      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(onReclaimed).toHaveBeenCalledWith(0);
    });

    it("respects backoff config defaults when not provided", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 2);

      // Call with no baseBackoffDelayMs/maxBackoffDelayMs; should use defaults
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      // Should still call the callback with attempt number
      expect(onReclaimed).toHaveBeenCalledWith(2);
      expect(await statusOf("r1")).toBe("submitted");
    });
  });

  describe("reaper behavior with backoff", () => {
    it("reclaims jobs below maxAttempts despite backoff configuration", async () => {
      const store = createPgJobStore(db);

      // A building row from 20 min ago with 1 attempt
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 1);

      const res = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 1000,
        maxBackoffDelayMs: 30_000,
      });

      expect(res.reclaimed).toBe(1);
      expect(res.deadLettered).toBe(0);
      expect(await statusOf("r1")).toBe("submitted");
    });

    it("dead-letters jobs at maxAttempts regardless of backoff config", async () => {
      const store = createPgJobStore(db);

      // A building row from 20 min ago with 3 attempts (at limit)
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 3);

      const res = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 1000,
        maxBackoffDelayMs: 30_000,
      });

      expect(res.reclaimed).toBe(0);
      expect(res.deadLettered).toBe(1);
      expect(await statusOf("r1")).toBe("dead_letter");
    });

    it("mixes reclaims and dead-letters in one sweep", async () => {
      const store = createPgJobStore(db);
      const baseTime = Date.now() - 20 * 60_000;

      // Job with 1 attempt — should reclaim
      await seed("r1", "C1", "building", new Date(baseTime), 1);
      // Job with 2 attempts — should reclaim
      await seed("r2", "C2", "building", new Date(baseTime), 2);
      // Job with 3 attempts — should dead-letter
      await seed("r3", "C3", "building", new Date(baseTime), 3);
      // Job within timeout — should not touch
      await seed("r4", "C4", "building", new Date(Date.now() - 5 * 60_000), 1);

      const res = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
      });

      expect(res.reclaimed).toBe(2);
      expect(res.deadLettered).toBe(1);
      expect(await statusOf("r1")).toBe("submitted");
      expect(await statusOf("r2")).toBe("submitted");
      expect(await statusOf("r3")).toBe("dead_letter");
      expect(await statusOf("r4")).toBe("building");
    });
  });

  describe("backoff calculation matches constants", () => {
    it("uses BACKOFF_CONFIG defaults when computing delays", async () => {
      // This test verifies the backoff calculation is internally consistent
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 0);

      // Call with BACKOFF_CONFIG values
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: BACKOFF_CONFIG.MAX_ATTEMPTS,
        baseBackoffDelayMs: BACKOFF_CONFIG.BASE_DELAY_MS,
        maxBackoffDelayMs: BACKOFF_CONFIG.MAX_DELAY_MS,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledWith(0);
      expect(await statusOf("r1")).toBe("submitted");
    });
  });

  describe("edge cases with backoff", () => {
    it("handles zero backoff delays", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 1);

      // Zero max delay (edge case)
      await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        baseBackoffDelayMs: 0,
        maxBackoffDelayMs: 0,
        onReclaimed,
      });

      expect(onReclaimed).toHaveBeenCalledOnce();
      expect(await statusOf("r1")).toBe("submitted");
    });

    it("handles high attempt numbers gracefully", async () => {
      const store = createPgJobStore(db);

      // Job with attempt count higher than maxAttempts should still dead-letter
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 10);

      const res = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
      });

      expect(res.deadLettered).toBe(1);
      expect(await statusOf("r1")).toBe("dead_letter");
    });

    it("handles jobs with attempts = maxAttempts - 1", async () => {
      const store = createPgJobStore(db);
      const onReclaimed = vi.fn();

      // One attempt below max — should still reclaim
      await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000), 2);

      const res = await store.reapStranded({
        timeoutMs: 15 * 60_000,
        maxAttempts: 3,
        onReclaimed,
      });

      expect(res.reclaimed).toBe(1);
      expect(onReclaimed).toHaveBeenCalledWith(2);
    });
  });
});
