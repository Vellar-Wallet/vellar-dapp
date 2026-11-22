import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { VerificationRecordInternal } from "@vellar/verification-service/server";
import type { VerificationStatus } from "@vellar/types";
import { createMemoryJobStore } from "./memory-job-store";
import { createPgJobStore } from "./pg-job-store";
import type { ClaimedJob, VerificationJobStore } from "./job-store";
import type { VerificationJobInput, VerificationOutcome } from "./verify";

// Shared contract for the two interchangeable VerificationJobStore
// implementations (#797). Every method is exercised against BOTH stores with
// the same seed and the same assertions, so swapping in-memory for Postgres
// can no longer silently change queue semantics. The Postgres variant uses a
// throwaway schema and runs locally when TEST_DATABASE_URL is set (CI always
// sets it, alongside CI_REQUIRE_DB=1).

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface Seed {
  id: string;
  contractId: string;
  status: VerificationStatus;
  createdAtMs?: number;
  updatedAtMs?: number;
  attempts?: number;
  outputHash?: string;
  deployedHash?: string;
  matchMode?: "exact" | "toolchain-metadata";
  startedBuildingAtMs?: number;
  completedAtMs?: number;
}

/** The small seam the shared suite needs to set up and inspect each store. */
interface Harness {
  store: VerificationJobStore;
  seed(rows: Seed[]): Promise<void>;
  statusOf(id: string): Promise<string | undefined>;
  attemptsOf(id: string): Promise<number>;
}

const CREATED_AT = Date.parse("2026-01-01T00:00:00.000Z");

function input(contractId: string): VerificationJobInput {
  return {
    contractId,
    sourceType: "repo",
    repoUrl: "https://github.com/x/y",
    commitHash: "abc1234",
    toolchainVersion: "1.94.0",
  };
}

function outcome(status: "verified" | "failed", outputHash?: string): VerificationOutcome {
  return {
    status,
    outputHash,
    deployedHash: outputHash,
    matchMode: outputHash ? "exact" : undefined,
    log: "contract test",
    statusDetail: "contract test",
  };
}

function makeMemoryHarness(): Harness {
  const store = createMemoryJobStore();
  return {
    store,
    async seed(rows) {
      for (const row of rows) {
        store.submit(row.id, input(row.contractId), row.createdAtMs ?? CREATED_AT);
        const stored = store.get(row.id)!;
        stored.status = row.status;
        stored.attempts = row.attempts;
        stored.startedBuildingAtMs = row.startedBuildingAtMs;
        stored.outputHash = row.outputHash;
        stored.deployedHash = row.deployedHash;
        stored.matchMode = row.matchMode;
        stored.completedAtMs = row.completedAtMs ?? row.updatedAtMs;
      }
    },
    async statusOf(id) {
      return store.get(id)?.status;
    },
    async attemptsOf(id) {
      return store.get(id)?.attempts ?? 0;
    },
  };
}

function recordFor(row: Seed): VerificationRecordInternal {
  return {
    id: row.id,
    contractId: row.contractId,
    sourceType: "repo",
    repoUrl: "https://github.com/x/y",
    commitHash: "abc1234",
    toolchainVersion: "1.94.0",
    status: row.status,
    createdAt: new Date(row.createdAtMs ?? CREATED_AT).toISOString(),
    updatedAt: new Date(row.updatedAtMs ?? row.createdAtMs ?? CREATED_AT).toISOString(),
    attempts: row.attempts,
    outputHash: row.outputHash,
    deployedHash: row.deployedHash,
    matchMode: row.matchMode,
  } as VerificationRecordInternal;
}

function makePgHarness(db: NodePgDatabase): Harness {
  return {
    store: createPgJobStore(db, { log: { warn: () => {}, error: () => {} } }),
    async seed(rows) {
      for (const row of rows) {
        const createdAt = new Date(row.createdAtMs ?? CREATED_AT).toISOString();
        const updatedAt = new Date(
          row.updatedAtMs ?? row.startedBuildingAtMs ?? row.createdAtMs ?? CREATED_AT,
        ).toISOString();
        const record = { ...recordFor(row), createdAt, updatedAt };
        await db.execute(sql`
          INSERT INTO verification_records (id, contract_id, status, created_at, updated_at, record)
          VALUES (
            ${row.id}, ${row.contractId}, ${row.status}, ${createdAt}::timestamptz,
            ${updatedAt}::timestamptz, ${JSON.stringify(record)}::jsonb
          )
        `);
      }
    },
    async statusOf(id) {
      const result = await db.execute<{ status: string }>(
        sql`SELECT status FROM verification_records WHERE id = ${id}`,
      );
      return (result as unknown as { rows: { status: string }[] }).rows[0]?.status;
    },
    async attemptsOf(id) {
      const result = await db.execute<{ attempts: number | null }>(sql`
        SELECT coalesce((record->>'attempts')::int, 0) AS attempts
        FROM verification_records WHERE id = ${id}
      `);
      return (result as unknown as { rows: { attempts: number | null }[] }).rows[0]?.attempts ?? 0;
    },
  };
}

/** One method-per-contract suite, parameterized over any Harness. */
function runContractTests(getHarness: () => Harness) {
  it("claimSubmitted claims only submitted rows, in order, up to the limit", async () => {
    const h = getHarness();
    await h.seed([
      { id: "a", contractId: C1, status: "submitted" },
      { id: "b", contractId: C2, status: "submitted", createdAtMs: CREATED_AT + 1 },
      { id: "c", contractId: C1, status: "verified" },
    ]);

    const first: ClaimedJob[] = await h.store.claimSubmitted(1);
    expect(first.map((j) => j.recordId)).toEqual(["a"]);
    expect(first[0]?.contractId).toBe(C1);
    expect(first[0]?.submittedAtMs).toBe(CREATED_AT);
    expect(await h.statusOf("a")).toBe("building");
    expect(await h.attemptsOf("a")).toBe(1);
    expect(await h.statusOf("b")).toBe("submitted");

    // A claimed job is never handed out twice.
    const second = await h.store.claimSubmitted(10);
    expect(second.map((j) => j.recordId)).toEqual(["b"]);
  });

  it("complete records a terminal outcome and removes the job from the active queue", async () => {
    const h = getHarness();
    await h.seed([{ id: "a", contractId: C1, status: "submitted" }]);
    await h.store.claimSubmitted(1);

    await h.store.complete("a", outcome("verified", HASH_A));

    expect(await h.statusOf("a")).toBe("verified");
    expect(await h.store.countActive()).toBe(0);
    expect(await h.store.listLatestVerified(10)).toEqual([{ contractId: C1, outputHash: HASH_A }]);
  });

  it("reapStranded ignores fresh jobs and reclaims stranded ones past the timeout", async () => {
    const h = getHarness();
    await h.seed([{ id: "a", contractId: C1, status: "submitted" }]);
    await h.store.claimSubmitted(1);
    const onReclaimed = vi.fn();
    const onDeadLettered = vi.fn();

    const fresh = await h.store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: Date.now() + 1_000,
      onReclaimed,
      onDeadLettered,
    });
    expect(fresh).toEqual({ reclaimed: 0, deadLettered: 0 });
    expect(await h.statusOf("a")).toBe("building");

    const stranded = await h.store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: Date.now() + 900_001,
      onReclaimed,
      onDeadLettered,
    });
    expect(stranded).toEqual({ reclaimed: 1, deadLettered: 0 });
    expect(await h.statusOf("a")).toBe("submitted");
    expect(onReclaimed).toHaveBeenCalledWith(expect.any(Number));
    expect(onDeadLettered).not.toHaveBeenCalled();
  });

  it("reapStranded dead-letters a job that exhausted its attempts", async () => {
    const h = getHarness();
    await h.seed([
      {
        id: "a",
        contractId: C1,
        status: "building",
        attempts: 3,
        startedBuildingAtMs: Date.now(),
      },
    ]);
    const onDeadLettered = vi.fn();

    const result = await h.store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: Date.now() + 900_001,
      onDeadLettered,
    });

    expect(result).toEqual({ reclaimed: 0, deadLettered: 1 });
    expect(await h.statusOf("a")).toBe("dead_letter");
    expect(onDeadLettered).toHaveBeenCalledOnce();
    expect(await h.store.claimSubmitted(10)).toHaveLength(0);
  });

  it("countActive counts submitted and building, but not terminal rows", async () => {
    const h = getHarness();
    await h.seed([
      { id: "a", contractId: C1, status: "submitted" },
      { id: "b", contractId: C2, status: "building" },
      { id: "c", contractId: C1, status: "verified" },
      { id: "d", contractId: C2, status: "failed" },
      { id: "e", contractId: C1, status: "dead_letter" },
    ]);
    expect(await h.store.countActive()).toBe(2);
  });

  it("hasActiveForContract is true only while a contract has active rows", async () => {
    const h = getHarness();
    await h.seed([
      { id: "a", contractId: C1, status: "building" },
      { id: "b", contractId: C2, status: "verified" },
    ]);
    expect(await h.store.hasActiveForContract(C1)).toBe(true);
    expect(await h.store.hasActiveForContract(C2)).toBe(false);
    expect(await h.store.hasActiveForContract("CNONE")).toBe(false);
  });

  it("listLatestVerified keeps only the latest terminal run when it verified", async () => {
    const h = getHarness();
    await h.seed([
      {
        id: "old-verified",
        contractId: C1,
        status: "verified",
        outputHash: HASH_A,
        updatedAtMs: CREATED_AT + 1,
        completedAtMs: CREATED_AT + 1,
      },
      {
        id: "new-verified",
        contractId: C1,
        status: "verified",
        outputHash: HASH_B,
        updatedAtMs: CREATED_AT + 2,
        completedAtMs: CREATED_AT + 2,
      },
      {
        id: "failed-after-verified",
        contractId: C2,
        status: "failed",
        updatedAtMs: CREATED_AT + 4,
        completedAtMs: CREATED_AT + 4,
      },
      {
        id: "earlier-verified",
        contractId: C2,
        status: "verified",
        outputHash: HASH_A,
        updatedAtMs: CREATED_AT + 3,
        completedAtMs: CREATED_AT + 3,
      },
      {
        id: "unverified",
        contractId: C1,
        status: "submitted",
      },
    ]);

    const listed = await h.store.listLatestVerified(10);
    expect(listed).toContainEqual({ contractId: C1, outputHash: HASH_B });
    expect(listed).not.toContainEqual({ contractId: C1, outputHash: HASH_A });
    expect(listed.some((r) => r.contractId === C2)).toBe(false);
  });

  it("listLatestVerified respects the limit", async () => {
    const h = getHarness();
    await h.seed([
      {
        id: "a",
        contractId: C1,
        status: "verified",
        outputHash: HASH_A,
        updatedAtMs: CREATED_AT + 1,
        completedAtMs: CREATED_AT + 1,
      },
      {
        id: "b",
        contractId: C2,
        status: "verified",
        outputHash: HASH_B,
        updatedAtMs: CREATED_AT + 2,
        completedAtMs: CREATED_AT + 2,
      },
    ]);
    expect(await h.store.listLatestVerified(1)).toHaveLength(1);
  });
}

describe("createMemoryJobStore — VerificationJobStore contract (#797)", () => {
  runContractTests(makeMemoryHarness);
});

describe.skipIf(!DATABASE_URL)("createPgJobStore — VerificationJobStore contract (#797)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      options: "-c search_path=worker_job_store_contract_test",
    });
    await pool.query("CREATE SCHEMA IF NOT EXISTS worker_job_store_contract_test");
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

  runContractTests(() => makePgHarness(db));
});
