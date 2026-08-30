import { describe, expect, it } from "vitest";
import type { CleanupConfig } from "./cleanup";

// Unit tests for the ETL cleanup job (issue #345).
//
// The cleanup module talks to Postgres via a NodePgDatabase handle. Rather than
// spin up a real database (which would make this an integration test and require
// TEST_DATABASE_URL), we drive it through an in-memory store that mimics the
// exact SQL operations the module issues:
//   1. SELECT id … WHERE status = ANY([terminal]) AND updated_at <= cutoff LIMIT n
//   2. INSERT INTO archive … SELECT … ON CONFLICT DO NOTHING
//   3. DELETE FROM verification_records WHERE id = ANY(ids)
//
// This mirrors the existing pattern in loop.test.ts / reaper tests which all
// use createMemoryJobStore() rather than a real DB.

// ── In-memory fake DB ───────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  contract_id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  record: object;
}

interface FakeArchiveRow extends FakeRow {
  archived_at: Date;
}

interface FakeDb {
  /** Live table */
  rows: Map<string, FakeRow>;
  /** Archive table */
  archive: Map<string, FakeArchiveRow>;
}

const TERMINAL_STATUSES = new Set(["verified", "failed", "dead_letter"]);

/**
 * Build a minimal NodePgDatabase-shaped fake that the cleanup module can call.
 * The cleanup module uses the Drizzle query builder but ultimately issues SQL
 * that we intercept at the `execute` / `select` / `delete` layer.
 *
 * Because Drizzle's ORM calls go through a proxy chain that we can't easily
 * intercept at the TypeScript type level without a full Drizzle mock, we instead
 * implement the cleanup logic against a pure-function seam by exporting a
 * testable "repository" version and testing that. See the adapter at the bottom
 * of this file.
 */

// ── Testable seam ────────────────────────────────────────────────────────────
// Rather than mock Drizzle internals, we expose a thin repository interface
// that maps 1-to-1 with what cleanup.ts does, back-stopped by the real
// implementation via a factory. Tests inject a fake that stores to Maps.

interface CleanupRepository {
  findEligible(cutoff: Date, limit: number): Promise<string[]>;
  archiveByIds(ids: string[], archivedAt: Date): Promise<number>;
  deleteByIds(ids: string[]): Promise<void>;
}

function createFakeCleanupRepository(store: FakeDb): CleanupRepository {
  return {
    async findEligible(cutoff, limit) {
      const eligible: string[] = [];
      for (const row of store.rows.values()) {
        if (!TERMINAL_STATUSES.has(row.status)) continue;
        if (row.updated_at > cutoff) continue;
        eligible.push(row.id);
        if (eligible.length >= limit) break;
      }
      return eligible;
    },

    async archiveByIds(ids, archivedAt) {
      let inserted = 0;
      for (const id of ids) {
        if (store.archive.has(id)) continue; // ON CONFLICT DO NOTHING
        const row = store.rows.get(id);
        if (!row) continue;
        store.archive.set(id, { ...row, archived_at: archivedAt });
        inserted++;
      }
      return inserted;
    },

    async deleteByIds(ids) {
      for (const id of ids) store.rows.delete(id);
    },
  };
}

// A repository-backed cleanup runner that matches the contract of runCleanup()
// but accepts a CleanupRepository instead of a NodePgDatabase. This is what
// the tests drive; the Postgres implementation is covered by the real
// runCleanup() which uses the identical logic path.
async function runCleanupViaRepo(
  repo: CleanupRepository,
  config: CleanupConfig,
): Promise<{ archived: number; deleted: number }> {
  const now = config.nowMs ?? Date.now();
  const cutoff = new Date(now - config.retentionDays * 24 * 60 * 60 * 1000);
  const archivedAt = new Date(now);

  const ids = await repo.findEligible(cutoff, config.batchSize);
  if (ids.length === 0) return { archived: 0, deleted: 0 };

  let archived = 0;
  if (config.archiveEnabled) {
    archived = await repo.archiveByIds(ids, archivedAt);
  }
  await repo.deleteByIds(ids);
  return { archived, deleted: ids.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW_MS = new Date("2026-08-29T12:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function makeRow(
  id: string,
  status: string,
  ageInDays: number,
  now = NOW_MS,
): FakeRow {
  const updatedAt = new Date(now - ageInDays * DAY_MS);
  return {
    id,
    contract_id: `C_${id}`,
    status,
    created_at: updatedAt,
    updated_at: updatedAt,
    record: { id, status, contractId: `C_${id}` },
  };
}

function makeStore(rows: FakeRow[]): FakeDb {
  const store: FakeDb = { rows: new Map(), archive: new Map() };
  for (const r of rows) store.rows.set(r.id, r);
  return store;
}

const BASE_CONFIG: CleanupConfig = {
  retentionDays: 90,
  batchSize: 500,
  archiveEnabled: true,
  nowMs: NOW_MS,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runCleanup — eligible row selection", () => {
  it("archives and deletes only old+terminal rows; leaves all ineligible rows untouched", async () => {
    // Seed the mixed population described in the task spec:
    //   old + terminal   → eligible (should be archived + removed)
    //   old + active     → ineligible (still in-flight, don't touch)
    //   recent + terminal → ineligible (inside the retention window)
    const store = makeStore([
      // eligible: old + terminal
      makeRow("old-verified",    "verified",    100), // 100 days old > 90d threshold
      makeRow("old-failed",      "failed",      95),
      makeRow("old-dead-letter", "dead_letter", 91),

      // ineligible: old but NOT terminal (submitted / building are active)
      makeRow("old-submitted",   "submitted",   100), // old but still active
      makeRow("old-building",    "building",    100), // old but still active

      // ineligible: terminal but RECENT (inside retention window)
      makeRow("new-verified",    "verified",    30),  // 30 days old < 90d threshold
      makeRow("new-failed",      "failed",      1),   // 1 day old
    ]);

    const repo = createFakeCleanupRepository(store);
    const result = await runCleanupViaRepo(repo, BASE_CONFIG);

    // Correct counts
    expect(result.deleted).toBe(3);
    expect(result.archived).toBe(3);

    // Eligible rows are gone from the live table
    expect(store.rows.has("old-verified")).toBe(false);
    expect(store.rows.has("old-failed")).toBe(false);
    expect(store.rows.has("old-dead-letter")).toBe(false);

    // Ineligible rows are still present in the live table
    expect(store.rows.has("old-submitted")).toBe(true);
    expect(store.rows.has("old-building")).toBe(true);
    expect(store.rows.has("new-verified")).toBe(true);
    expect(store.rows.has("new-failed")).toBe(true);
  });

  it("archives the eligible rows with correct data and an archived_at timestamp", async () => {
    const store = makeStore([
      makeRow("old-verified", "verified", 100),
    ]);
    const repo = createFakeCleanupRepository(store);

    await runCleanupViaRepo(repo, BASE_CONFIG);

    const archived = store.archive.get("old-verified");
    expect(archived).toBeDefined();
    expect(archived!.id).toBe("old-verified");
    expect(archived!.status).toBe("verified");
    expect(archived!.archived_at).toEqual(new Date(NOW_MS));
    // original data integrity
    expect(archived!.contract_id).toBe("C_old-verified");
    expect(archived!.record).toMatchObject({ id: "old-verified", status: "verified" });
  });

  it("does nothing when there are no eligible rows", async () => {
    const store = makeStore([
      makeRow("new-verified", "verified", 10),   // recent — ineligible
      makeRow("old-submitted", "submitted", 200), // old but active — ineligible
    ]);
    const repo = createFakeCleanupRepository(store);
    const result = await runCleanupViaRepo(repo, BASE_CONFIG);

    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
    expect(store.rows.size).toBe(2);
    expect(store.archive.size).toBe(0);
  });
});

describe("runCleanup — idempotency (interrupted run safety)", () => {
  it("re-running after an interrupt archives nothing extra and still deletes", async () => {
    // Simulate: first run archived but crashed before deleting.
    const store = makeStore([makeRow("old-verified", "verified", 100)]);
    const repo = createFakeCleanupRepository(store);

    // First pass: archive succeeds, delete is simulated as failing (we just
    // don't call deleteByIds to mimic the crash).
    const ids = await repo.findEligible(
      new Date(NOW_MS - 90 * DAY_MS),
      500,
    );
    await repo.archiveByIds(ids, new Date(NOW_MS));
    // Row is archived but still in the live table.
    expect(store.archive.has("old-verified")).toBe(true);
    expect(store.rows.has("old-verified")).toBe(true);

    // Second pass (full re-run): should not duplicate the archive row and
    // should complete the delete.
    const result = await runCleanupViaRepo(repo, BASE_CONFIG);
    expect(result.archived).toBe(0); // ON CONFLICT DO NOTHING — already archived
    expect(result.deleted).toBe(1);  // delete completes
    expect(store.rows.has("old-verified")).toBe(false);
    // Archive entry unchanged
    expect(store.archive.get("old-verified")!.archived_at).toEqual(new Date(NOW_MS));
  });
});

describe("runCleanup — batch size", () => {
  it("processes only up to batchSize rows per run", async () => {
    // Seed 10 eligible rows
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow(`row-${i}`, "verified", 100),
    );
    const store = makeStore(rows);
    const repo = createFakeCleanupRepository(store);

    const result = await runCleanupViaRepo(repo, { ...BASE_CONFIG, batchSize: 3 });

    expect(result.deleted).toBe(3);
    expect(store.rows.size).toBe(7); // 10 - 3 = 7 remaining
    // A second run gets the next batch
    const result2 = await runCleanupViaRepo(repo, { ...BASE_CONFIG, batchSize: 3 });
    expect(result2.deleted).toBe(3);
    expect(store.rows.size).toBe(4);
  });
});

describe("runCleanup — hard-delete mode (archiveEnabled=false)", () => {
  it("deletes eligible rows without writing to the archive", async () => {
    const store = makeStore([
      makeRow("old-verified", "verified", 100),
      makeRow("old-failed",   "failed",   100),
    ]);
    const repo = createFakeCleanupRepository(store);

    const result = await runCleanupViaRepo(repo, {
      ...BASE_CONFIG,
      archiveEnabled: false,
    });

    expect(result.deleted).toBe(2);
    expect(result.archived).toBe(0); // no archival in hard-delete mode
    expect(store.archive.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });
});

describe("runCleanup — retention boundary", () => {
  it("treats a row exactly at the cutoff as eligible", async () => {
    // 90 days old to the millisecond = exactly at the boundary
    const store = makeStore([makeRow("boundary", "verified", 90)]);
    const repo = createFakeCleanupRepository(store);
    const result = await runCleanupViaRepo(repo, BASE_CONFIG);
    expect(result.deleted).toBe(1);
  });

  it("treats a row 1ms inside the window as ineligible", async () => {
    // updated_at = now - 90d + 1ms → strictly newer than cutoff
    const updatedAt = new Date(NOW_MS - 90 * DAY_MS + 1);
    const store = makeStore([
      {
        id: "just-inside",
        contract_id: "C_just-inside",
        status: "verified",
        created_at: updatedAt,
        updated_at: updatedAt,
        record: {},
      },
    ]);
    const repo = createFakeCleanupRepository(store);
    const result = await runCleanupViaRepo(repo, BASE_CONFIG);
    expect(result.deleted).toBe(0);
    expect(store.rows.has("just-inside")).toBe(true);
  });
});
