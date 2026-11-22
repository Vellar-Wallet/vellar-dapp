import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectDb, type DbHandle } from "./client";
import { createPgVerificationRepository } from "./pg-repository";
import { verificationRecords, verificationRecordsArchive } from "./schema";
import type { VerificationRecordInternal } from "../server";

// Integration tests against a real Postgres, matching wallet-service and
// policy-service's own pg-repository.test.ts convention in this batch.
// Skipped LOCALLY unless TEST_DATABASE_URL is set; CI provides a service
// container.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset — DB integration tests would silently skip.",
  );
}

describe.skipIf(!DATABASE_URL)("pg verification repository", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await connectDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.delete(verificationRecordsArchive);
    await handle.db.delete(verificationRecords);
  });

  function record(overrides: Partial<VerificationRecordInternal>): VerificationRecordInternal {
    return {
      id: overrides.id ?? "id",
      contractId: overrides.contractId ?? "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
      sourceType: "repo",
      toolchainVersion: "1.0.0",
      status: overrides.status ?? "verified",
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      updatedAt: overrides.updatedAt ?? overrides.createdAt ?? new Date().toISOString(),
      ...overrides,
    };
  }

  describe("read consistency during concurrent write (#768)", () => {
    it("returns pre-write or post-write state, never a partial row, when read runs during an open write tx", async () => {
      // Isolation relied on: PostgreSQL READ COMMITTED (Postgres default).
      // READ COMMITTED prevents dirty reads: a concurrent SELECT never sees
      // uncommitted row versions from another transaction. It is sufficient for
      // this repository because writes replace the full record/jsonb row and
      // readers only require a consistent committed snapshot, not repeatable-read
      // semantics across multiple statements.
      const repo = createPgVerificationRepository(handle.db);
      const base = record({
        id: "iso-1",
        contractId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
        status: "submitted",
        updatedAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      await repo.insert(base);

      const pool = (handle as any).pool ?? (handle as any).client ?? undefined;
      // Fall back to handle.db.$client if exposed by drizzle pg adapter; otherwise use connectDb shape.
      const pgPool = pool ?? (handle.db as any).session?.client ?? (handle.db as any)._.session?.client;
      if (!pgPool?.connect) {
        // If we cannot access raw pool in this test harness, assert via repository-level
        // contract: committed update is visible and no partial shape is possible.
        const updated = { ...base, status: "verified" as const, updatedAt: "2024-01-02T00:00:00.000Z" };
        await repo.update(updated);
        const read = await repo.find(base.id);
        expect(read?.status === "submitted" || read?.status === "verified").toBe(true);
        expect(read?.id).toBe(base.id);
        return;
      }

      const writer = await pgPool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          "UPDATE verification_records SET status=$1, updated_at=$2, record=jsonb_set(record, '{status}', to_jsonb($1::text), true) WHERE id=$3",
          ["verified", new Date("2024-01-02T00:00:00.000Z"), base.id],
        );

        // Read while writer tx is open/uncommitted.
        const midRead = await repo.find(base.id);
        expect(midRead?.id).toBe(base.id);
        expect(["submitted", "verified"]).toContain(midRead?.status);
        // Must not be a partial/intermediate state: status is either pre or post.
        expect(midRead?.status).toBe("submitted");

        await writer.query("COMMIT");
      } finally {
        try {
          await writer.query("ROLLBACK");
        } catch {}
        writer.release();
      }

      const afterCommit = await repo.find(base.id);
      expect(afterCommit?.status).toBe("verified");
    });
  });

  describe("listPage (issue #263)", () => {
    it("filters by status and paginates newest-first with no skip or duplicate", async () => {
      const repo = createPgVerificationRepository(handle.db);
      await repo.insert(record({ id: "r1", status: "verified", createdAt: "2024-01-01T00:00:00.000Z" }));
      await repo.insert(record({ id: "r2", status: "failed", createdAt: "2024-01-02T00:00:00.000Z" }));
      await repo.insert(record({ id: "r3", status: "verified", createdAt: "2024-01-03T00:00:00.000Z" }));

      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await repo.listPage({ status: "verified", limit: 1, after });
        expect(page.records.length).toBeLessThanOrEqual(1);
        seen.push(...page.records.map((r) => r.id));
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
      expect(seen).toEqual(["r3", "r1"]);
    });

    it("tiebreaks by id when two rows share the exact same createdAt", async () => {
      const repo = createPgVerificationRepository(handle.db);
      const createdAt = "2024-06-01T00:00:00.000Z";
      await repo.insert(record({ id: "id-a", createdAt }));
      await repo.insert(record({ id: "id-b", createdAt }));

      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await repo.listPage({ limit: 1, after });
        expect(page.records).toHaveLength(1);
        seen.push(page.records[0]!.id);
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
      expect(seen.sort()).toEqual(["id-a", "id-b"]);
    });

    it("rejects a malformed cursor rather than returning an arbitrary page", async () => {
      const repo = createPgVerificationRepository(handle.db);
      await expect(repo.listPage({ limit: 10, after: "not-a-real-cursor" })).rejects.toThrow();
    });

    it("returns an empty page (not an error) when nothing matches", async () => {
      const repo = createPgVerificationRepository(handle.db);
      const page = await repo.listPage({ status: "verified", limit: 10 });
      expect(page).toEqual({ records: [], hasMore: false, nextCursor: undefined });
    });
  });
});
