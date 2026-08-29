import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createPgJobStore } from "./pg-job-store";
import type { VerificationRecordInternal } from "@vellar/verification-service/server";

// Integration tests against a real Postgres (M7 reaper + queue controls). The
// atomic reclaim/dead-letter SQL can only be verified against a real DB.
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("createPgJobStore — reaper + queue controls (M7)", () => {
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
  ) {
    await db.execute(sql`
      INSERT INTO verification_records (id, contract_id, status, created_at, updated_at, record)
      VALUES (${id}, ${contractId}, ${status}, now(), ${updatedAt}, ${JSON.stringify(record(id, contractId))}::jsonb)
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

  it("claim bumps the attempts counter in jsonb", async () => {
    const store = createPgJobStore(db);
    await seed("r1", "C1");
    expect(await attemptsOf("r1")).toBe(0);
    await store.claimSubmitted(1);
    expect(await attemptsOf("r1")).toBe(1);
    expect(await statusOf("r1")).toBe("building");
  });

  it("reaps a stranded 'building' row back to 'submitted' past the timeout", async () => {
    const store = createPgJobStore(db);
    // A building row whose updated_at is 20 min ago (past a 15-min timeout).
    await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000));
    const res = await store.reapStranded({ timeoutMs: 15 * 60_000, maxAttempts: 3 });
    expect(res.reclaimed).toBe(1);
    expect(res.deadLettered).toBe(0);
    expect(await statusOf("r1")).toBe("submitted");
  });

  it("does not reap a 'building' row still within the timeout", async () => {
    const store = createPgJobStore(db);
    await seed("r1", "C1", "building", new Date(Date.now() - 5 * 60_000));
    const res = await store.reapStranded({ timeoutMs: 15 * 60_000, maxAttempts: 3 });
    expect(res.reclaimed).toBe(0);
    expect(await statusOf("r1")).toBe("building");
  });

  it("dead-letters a row that has already used all its attempts", async () => {
    const store = createPgJobStore(db);
    await seed("r1", "C1", "building", new Date(Date.now() - 20 * 60_000));
    // Set attempts=3 in the jsonb to simulate a job stranded for the 3rd time.
    await db.execute(
      sql`UPDATE verification_records SET record = jsonb_set(record, '{attempts}', '3') WHERE id = 'r1'`,
    );
    const res = await store.reapStranded({ timeoutMs: 15 * 60_000, maxAttempts: 3 });
    expect(res.deadLettered).toBe(1);
    expect(res.reclaimed).toBe(0);
    expect(await statusOf("r1")).toBe("dead_letter");
    // Dead-lettered rows are never claimed again.
    expect(await store.claimSubmitted(10)).toHaveLength(0);
  });

  it("countActive counts submitted+building only", async () => {
    const store = createPgJobStore(db);
    await seed("r1", "C1", "submitted");
    await seed("r2", "C2", "building");
    await seed("r3", "C3", "verified");
    await seed("r4", "C4", "dead_letter");
    expect(await store.countActive()).toBe(2);
  });

  it("hasActiveForContract is true for submitted/building, false when only terminal", async () => {
    const store = createPgJobStore(db);
    await seed("r1", "C1", "building");
    await seed("r2", "C2", "verified");
    expect(await store.hasActiveForContract("C1")).toBe(true);
    expect(await store.hasActiveForContract("C2")).toBe(false);
    expect(await store.hasActiveForContract("C3")).toBe(false);
  });
});

// ── Import-validation unit tests (issue #346) ───────────────────────────────────
// These tests do NOT require a real Postgres — they test the validation logic
// and the logger callback using a fake DB-shape object.

describe("createPgJobStore — import-validation (issue #346)", () => {
  const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
  const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  function validRecord(id: string): VerificationRecordInternal {
    return {
      id,
      contractId: C1,
      sourceType: "repo",
      repoUrl: "https://github.com/x/y",
      commitHash: "abc1234",
      toolchainVersion: "1.94.0",
      status: "submitted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  /**
   * Fake DB-shaped object that implements just enough of the drizzle interface
   * for createPgJobStore's claimSubmitted to work. We control the rows returned
   * to test import-validation behavior in isolation.
   */
  function makeFakeDb(rows: Array<{ id: string; record: unknown }>) {
    return {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve(rows),
          }),
        }),
      }),
    } as unknown as NodePgDatabase;
  }

  it("accepts a valid record and maps it to ClaimedJob", async () => {
    const fakeDb = makeFakeDb([{ id: "rec-1", record: validRecord("rec-1") }]);
    const store = createPgJobStore(fakeDb);

    const claimed = await store.claimSubmitted(10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].recordId).toBe("rec-1");
    expect(claimed[0].contractId).toBe(C1);
  });

  it("rejects a record with malformed contractId and logs the reason", async () => {
    const fakeDb = makeFakeDb([
      {
        id: "rec-bad",
        record: { ...validRecord("rec-bad"), contractId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM" },
      },
    ]);

    let logged = false;
    let loggedReason = "";
    const store = createPgJobStore(fakeDb, {
      log: {
        warn: (msg: string) => {
          logged = true;
          loggedReason = msg;
        },
        error: () => {},
      },
    });

    const claimed = await store.claimSubmitted(10);

    expect(claimed).toHaveLength(0); // rejected
    expect(logged).toBe(true);
    expect(loggedReason).toContain("import-validation");
    expect(loggedReason).toContain("rec-bad");
    expect(loggedReason).toContain("contractId");
  });

  it("rejects missing required fields and logs the reason", async () => {
    const fakeDb = makeFakeDb([
      { id: "rec-broken", record: { ...validRecord("rec-broken"), toolchainVersion: "" } },
    ]);

    let loggedReason = "";
    const store = createPgJobStore(fakeDb, {
      log: {
        warn: (msg: string) => {
          loggedReason = msg;
        },
        error: () => {},
      },
    });

    const claimed = await store.claimSubmitted(10);

    expect(claimed).toHaveLength(0);
    expect(loggedReason).toContain("toolchainVersion");
  });

  it("processes a mixed batch: valid records are claimed, invalid ones are skipped+logged", async () => {
    const fakeDb = makeFakeDb([
      { id: "rec-1", record: validRecord("rec-1") }, // valid
      {
        id: "rec-2",
        record: { ...validRecord("rec-2"), contractId: "INVALID" },
      }, // bad contract
      { id: "rec-3", record: validRecord("rec-3") }, // valid
      {
        id: "rec-4",
        record: { ...validRecord("rec-4"), status: "pending" },
      }, // bad status enum
    ]);

    let rejections: string[] = [];
    const store = createPgJobStore(fakeDb, {
      log: {
        warn: (msg: string) => {
          rejections.push(msg);
        },
        error: () => {},
      },
    });

    const claimed = await store.claimSubmitted(10);

    // Only the two valid records were claimed.
    expect(claimed).toHaveLength(2);
    expect(claimed.map((c) => c.recordId)).toEqual(["rec-1", "rec-3"]);

    // Two rejections were logged, one for each invalid record.
    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toContain("rec-2");
    expect(rejections[0]).toContain("contractId");
    expect(rejections[1]).toContain("rec-4");
    expect(rejections[1]).toContain("status");
  });

  it("converts createdAt to submittedAtMs correctly", async () => {
    const createdAt = "2026-06-15T10:30:00.000Z";
    const expectedMs = Date.parse(createdAt);
    const fakeDb = makeFakeDb([
      { id: "rec-1", record: { ...validRecord("rec-1"), createdAt } },
    ]);

    const store = createPgJobStore(fakeDb);
    const claimed = await store.claimSubmitted(1);

    expect(claimed[0].submittedAtMs).toBe(expectedMs);
  });

  it("handles optional fields correctly when present", async () => {
    const fakeDb = makeFakeDb([
      {
        id: "rec-1",
        record: {
          ...validRecord("rec-1"),
          lockfileHash: "deadbeef",
          outputHash: "a".repeat(64),
          deployedHash: "b".repeat(64),
          buildFlags: ["--release", "--opt-level=z"],
        },
      },
    ]);

    const store = createPgJobStore(fakeDb);
    const claimed = await store.claimSubmitted(1);

    expect(claimed[0].buildFlags).toEqual(["--release", "--opt-level=z"]);
  });

  it("skips unknown extra jsonb fields (forward-compatible)", async () => {
    const fakeDb = makeFakeDb([
      {
        id: "rec-1",
        record: {
          ...validRecord("rec-1"),
          _futureField: "ignored",
          attempts: 1,
        },
      },
    ]);

    const store = createPgJobStore(fakeDb);
    const claimed = await store.claimSubmitted(1);

    // Should succeed — unknown fields don't cause rejection.
    expect(claimed).toHaveLength(1);
    expect(claimed[0].recordId).toBe("rec-1");
  });
});
