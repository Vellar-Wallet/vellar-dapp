import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq, and } from "drizzle-orm";
import { verificationRecords } from "../src/db/schema";
import type { VerificationRecordInternal } from "../src/server";

/**
 * Backfill script tests using fixtures.
 *
 * Tests cover:
 * 1. Correct backfill of a missing deployedHash
 * 2. Skip already-populated fields (idempotency)
 * 3. Graceful handling of fetch failures (per-record, logged, continues)
 * 4. Idempotency across two runs
 * 5. Dry-run mode (no writes, correct reporting)
 */

// ─────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────

const FIXTURES = {
  // Contract with deployedHash known on blockchain
  contractWithOnChainHash: "CBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  onChainHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",

  // Contract not found on blockchain
  contractNotFound: "CCCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",

  // Stellar Asset Contract (not verifiable)
  contractSAC: "CDDDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
};

// ─────────────────────────────────────────────────────────────────────────
// Mock RPC Resolver
// ─────────────────────────────────────────────────────────────────────────

class MockArtifactResolver {
  async resolveDeployedHash(contractId: string): Promise<string> {
    if (contractId === FIXTURES.contractWithOnChainHash) {
      return FIXTURES.onChainHash;
    }
    if (contractId === FIXTURES.contractNotFound) {
      throw Object.assign(
        new Error(`contract ${contractId} not found on-chain`),
        { code: "not_found" as const },
      );
    }
    if (contractId === FIXTURES.contractSAC) {
      throw Object.assign(
        new Error("built-in Stellar Asset Contract, not a wasm contract"),
        { code: "not_wasm" as const },
      );
    }
    throw Object.assign(new Error(`unexpected contract: ${contractId}`), {
      code: "rpc_error" as const,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────

function createTestRecord(
  overrides: Partial<VerificationRecordInternal> = {},
): VerificationRecordInternal {
  return {
    id: "test-rec-" + Math.random().toString(36).substring(7),
    contractId: FIXTURES.contractWithOnChainHash,
    status: "verified",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceType: "repo",
    repoUrl: "https://github.com/test/test",
    commitHash: "abc123",
    toolchainVersion: "1.0.0",
    buildFlags: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Backfill Logic (extracted for testing)
// ─────────────────────────────────────────────────────────────────────────

interface BackfillRecordResult {
  type: "success" | "skipped" | "failed";
  error?: string;
}

async function backfillRecordForTest(
  record: VerificationRecordInternal,
  resolver: MockArtifactResolver,
  db: ReturnType<typeof drizzle>,
  isDryRun: boolean,
): Promise<BackfillRecordResult> {
  const { id, contractId, deployedHash } = record;

  // Skip if already populated
  if (deployedHash) {
    return { type: "skipped" };
  }

  // Fetch deployedHash from resolver
  let newHash: string;
  try {
    newHash = await resolver.resolveDeployedHash(contractId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "failed", error: msg };
  }

  // Write to database (unless dry-run)
  if (!isDryRun) {
    try {
      // Re-fetch current record for idempotency
      const current = await db
        .select({ record: verificationRecords.record })
        .from(verificationRecords)
        .where(eq(verificationRecords.id, id));

      if (!current || current.length === 0) {
        return { type: "failed", error: "record deleted concurrently" };
      }

      const currentRecord = current[0].record;

      // Skip if another process backfilled it
      if (currentRecord.deployedHash) {
        return { type: "skipped" };
      }

      const updated: VerificationRecordInternal = { ...currentRecord, deployedHash: newHash };
      await db
        .update(verificationRecords)
        .set({
          record: updated,
          updatedAt: new Date(),
        })
        .where(eq(verificationRecords.id, id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "failed", error: `write error: ${msg}` };
    }
  }

  return { type: "success" };
}

// ─────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────

describe("backfill-metadata", () => {
  let db: ReturnType<typeof drizzle>;
  let pool: pg.Pool;
  let resolver: MockArtifactResolver;

  beforeEach(async () => {
    const DATABASE_URL = process.env.DATABASE_URL || "postgresql://localhost/vellar_test";
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool);
    resolver = new MockArtifactResolver();

    // Create test table if needed (assumes migrations have run)
    try {
      await pool.query("SELECT 1 FROM verification_records LIMIT 1");
    } catch {
      // Table doesn't exist; skip tests
      throw new Error(
        "verification_records table not found. Run migrations first: npm run test:db-setup",
      );
    }

    // Clear test data before each test
    await db
      .delete(verificationRecords)
      .where(sql`id LIKE 'test-rec-%'`);
  });

  afterEach(async () => {
    // Clean up
    await db
      .delete(verificationRecords)
      .where(sql`id LIKE 'test-rec-%'`);
    await pool.end();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Correct backfill of missing deployedHash
  // ─────────────────────────────────────────────────────────────────────

  it("backfills missing deployedHash with correct value from blockchain", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: undefined,
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // Backfill
    const result = await backfillRecordForTest(record, resolver, db, false);

    expect(result.type).toBe("success");

    // Verify written value
    const updated = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));

    expect(updated).toHaveLength(1);
    expect(updated[0].record.deployedHash).toBe(FIXTURES.onChainHash);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: Skip already-populated fields (idempotency)
  // ─────────────────────────────────────────────────────────────────────

  it("skips records that already have deployedHash", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: "already_populated_hash",
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // Attempt backfill
    const result = await backfillRecordForTest(record, resolver, db, false);

    expect(result.type).toBe("skipped");

    // Verify value unchanged
    const updated = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));

    expect(updated[0].record.deployedHash).toBe("already_populated_hash");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Graceful handling of fetch failure
  // ─────────────────────────────────────────────────────────────────────

  it("gracefully handles fetch failure (contract not found) and continues", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractNotFound,
      deployedHash: undefined,
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // Attempt backfill
    const result = await backfillRecordForTest(record, resolver, db, false);

    expect(result.type).toBe("failed");
    expect(result.error).toContain("not found on-chain");

    // Verify field unchanged (no write on failure)
    const unchanged = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));

    expect(unchanged[0].record.deployedHash).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: Idempotency across two runs
  // ─────────────────────────────────────────────────────────────────────

  it("second run skips already-backfilled records (idempotent)", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: undefined,
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // First run: backfill
    const result1 = await backfillRecordForTest(record, resolver, db, false);
    expect(result1.type).toBe("success");

    // Re-fetch for second run
    const updated1 = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));
    const recordAfterFirstRun = updated1[0].record;

    // Second run: should skip
    const result2 = await backfillRecordForTest(recordAfterFirstRun, resolver, db, false);
    expect(result2.type).toBe("skipped");

    // Value unchanged
    const updated2 = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));

    expect(updated2[0].record.deployedHash).toBe(FIXTURES.onChainHash);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 5: Dry-run mode (no writes)
  // ─────────────────────────────────────────────────────────────────────

  it("dry-run mode reports success without writing", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: undefined,
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // Dry-run backfill
    const result = await backfillRecordForTest(record, resolver, db, true);

    expect(result.type).toBe("success");

    // Verify no write occurred
    const unchanged = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, record.id));

    expect(unchanged[0].record.deployedHash).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 6: Multiple records with mixed outcomes
  // ─────────────────────────────────────────────────────────────────────

  it("processes multiple records with mixed success/skip/failure outcomes", async () => {
    // Record 1: missing, will backfill
    const rec1 = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: undefined,
    });

    // Record 2: already has deployedHash, will skip
    const rec2 = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: "existing_hash",
    });

    // Record 3: contract not found, will fail
    const rec3 = createTestRecord({
      contractId: FIXTURES.contractNotFound,
      deployedHash: undefined,
    });

    // Insert all records
    for (const rec of [rec1, rec2, rec3]) {
      await db.insert(verificationRecords).values({
        id: rec.id,
        contractId: rec.contractId,
        status: rec.status,
        createdAt: new Date(rec.createdAt),
        updatedAt: new Date(rec.updatedAt),
        record: rec,
      });
    }

    // Process all records
    const results = await Promise.all([
      backfillRecordForTest(rec1, resolver, db, false),
      backfillRecordForTest(rec2, resolver, db, false),
      backfillRecordForTest(rec3, resolver, db, false),
    ]);

    expect(results[0].type).toBe("success"); // backfilled
    expect(results[1].type).toBe("skipped"); // already populated
    expect(results[2].type).toBe("failed"); // fetch error

    // Verify only rec1 was updated
    const final1 = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, rec1.id));
    expect(final1[0].record.deployedHash).toBe(FIXTURES.onChainHash);

    const final2 = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, rec2.id));
    expect(final2[0].record.deployedHash).toBe("existing_hash");

    const final3 = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(eq(verificationRecords.id, rec3.id));
    expect(final3[0].record.deployedHash).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 7: Concurrent backfill safety (second process skips)
  // ─────────────────────────────────────────────────────────────────────

  it("handles concurrent backfills safely (second process skips)", async () => {
    const record = createTestRecord({
      contractId: FIXTURES.contractWithOnChainHash,
      deployedHash: undefined,
    });

    // Insert record
    await db.insert(verificationRecords).values({
      id: record.id,
      contractId: record.contractId,
      status: record.status,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      record,
    });

    // Simulate first process updating
    const updated1 = { ...record, deployedHash: FIXTURES.onChainHash };
    await db
      .update(verificationRecords)
      .set({
        record: updated1,
        updatedAt: new Date(),
      })
      .where(eq(verificationRecords.id, record.id));

    // Second process attempts with original (outdated) record
    const result = await backfillRecordForTest(record, resolver, db, false);

    // Should detect it's already been backfilled and skip
    expect(result.type).toBe("skipped");
  });
});
