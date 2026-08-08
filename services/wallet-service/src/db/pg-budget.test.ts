import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createPgSpendBudget, type PgBudgetConfig } from "@vellar/service-kit";
import { connectDb, type DbHandle } from "./client";

// Integration tests against a real Postgres. Skipped unless TEST_DATABASE_URL
// is set (CI provisions one; locally: docker compose up + TEST_DATABASE_URL).
// The atomic conditional-INSERT that gives the concurrency guarantee can only
// be verified against a real DB, not a mock.
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("createPgSpendBudget (atomic rolling-window budget)", () => {
  let handle: DbHandle;
  let db: DbHandle["db"];

  const baseConfig: PgBudgetConfig = {
    windowMs: 3_600_000, // 1h
    limits: {
      sponsor: { maxStroops: 500_000_000n, maxCount: 500 }, // 50 XLM / 500
      deploy: { maxStroops: 200_000_000n, maxCount: 20 }, // 20 XLM / 20
      create: { maxCount: 30 }, // count-only
    },
  };

  beforeAll(async () => {
    // Use the real migration path (connectDb runs drizzle migrate) so this
    // suite and pg-repository.test share one migration-tracked schema.
    handle = await connectDb(DATABASE_URL as string);
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function ledgerRowCount(): Promise<number> {
    const res = await db.execute(sql`SELECT count(*)::int AS n FROM spend_ledger`);
    const rows = (res as unknown as { rows: { n: number }[] }).rows;
    return rows[0]?.n ?? 0;
  }

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE spend_ledger`);
  });

  it("allows spend under the XLM ceiling and records it", async () => {
    const budget = createPgSpendBudget(db, baseConfig);
    const r = await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 100_000n });
    expect(r.ok).toBe(true);
    expect(await ledgerRowCount()).toBe(1);
  });

  it("refuses once the XLM ceiling is reached (budget_exceeded)", async () => {
    const budget = createPgSpendBudget(db, {
      ...baseConfig,
      limits: { ...baseConfig.limits, sponsor: { maxStroops: 1_000_000n, maxCount: 500 } },
    });
    expect((await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1_000_000n })).ok).toBe(
      true,
    );
    const over = await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1n });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("budget_exceeded");
  });

  it("refuses once the COUNT ceiling is reached even with XLM headroom (create line)", async () => {
    const budget = createPgSpendBudget(db, {
      ...baseConfig,
      limits: { ...baseConfig.limits, create: { maxCount: 2 } },
    });
    expect((await budget.tryConsume({ line: "create", network: "testnet", stroops: 0n })).ok).toBe(true);
    expect((await budget.tryConsume({ line: "create", network: "testnet", stroops: 0n })).ok).toBe(true);
    expect((await budget.tryConsume({ line: "create", network: "testnet", stroops: 0n })).ok).toBe(false);
  });

  it("scopes by (line, network): mainnet budget is separate from testnet", async () => {
    const budget = createPgSpendBudget(db, {
      ...baseConfig,
      limits: { ...baseConfig.limits, sponsor: { maxStroops: 1_000_000n, maxCount: 1 } },
    });
    expect((await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1_000_000n })).ok).toBe(
      true,
    );
    // testnet is now full, but mainnet still has room.
    expect((await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1n })).ok).toBe(false);
    expect((await budget.tryConsume({ line: "sponsor", network: "mainnet", stroops: 1_000_000n })).ok).toBe(
      true,
    );
  });

  it("ignores rows outside the rolling window", async () => {
    // Insert an old row directly (2h ago) that should not count against a 1h window.
    await db.execute(sql`
      INSERT INTO spend_ledger (id, line, network, stroops, count, at)
      VALUES ('old', 'sponsor', 'testnet', 500000000, 1, now() - interval '2 hours')
    `);
    const budget = createPgSpendBudget(db, baseConfig);
    // 50 XLM ceiling; the old 50-XLM row is outside the window, so this passes.
    expect(
      (await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 400_000_000n })).ok,
    ).toBe(true);
  });

  it("CONCURRENCY: with room for exactly one more, only one of N parallel consumes succeeds", async () => {
    // Ceiling = 1 call. Fire 8 concurrent consumes; the atomic conditional
    // INSERT must let exactly one land.
    const budget = createPgSpendBudget(db, {
      ...baseConfig,
      limits: { ...baseConfig.limits, sponsor: { maxStroops: 500_000_000n, maxCount: 1 } },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1_000n }),
      ),
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(await ledgerRowCount()).toBe(1);
  });
});
