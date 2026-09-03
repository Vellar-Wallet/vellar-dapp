#!/usr/bin/env node
/**
 * Backfill script for verification_requests contract metadata.
 *
 * Backfills missing deployedHash values in verified records by fetching them
 * from the blockchain. Records are processed in batches with per-record error
 * handling and retry logic.
 *
 * Usage:
 *   tsx scripts/backfill-metadata.ts [--dry-run] [--confirm]
 *
 * Flags:
 *   --dry-run     Report affected rows without writing (default: true)
 *   --confirm     Actually write changes to the database (default: false)
 *
 * Exit codes:
 *   0: Success (all rows processed)
 *   1: Partial success (some rows failed)
 *   2: Fatal error (could not connect or query)
 */

import { sql, eq, and } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { verificationRecords } from "../src/db/schema";
import type { VerificationRecordInternal } from "../src/server";

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://localhost/vellar";
const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";

const BATCH_SIZE = 10;
const RPC_DELAY_MS = 1000; // Respect rate limits
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000; // Per record

const args = process.argv.slice(2);
const isDryRun = !args.includes("--confirm");
const verbose = args.includes("--verbose");

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface BackfillStats {
  totalAffected: number;
  succeeded: number;
  skipped: number;
  failed: number;
  failedIds: Array<{ id: string; contractId: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Artifact Resolver (reusing production logic)
// ─────────────────────────────────────────────────────────────────────────

interface ArtifactResolveError extends Error {
  code: "not_found" | "not_wasm" | "rpc_error";
}

async function resolveDeployedHash(contractId: string, rpcUrl: string): Promise<string> {
  const { Contract, rpc, xdr } = await import("@stellar/stellar-sdk");

  const server = new rpc.Server(rpcUrl);

  try {
    const entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );

    const instance = entry.val.contractData().val().instance();
    const executable = instance.executable();

    if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
      throw new Error(
        `contract ${contractId} is a built-in Stellar Asset Contract, not a wasm contract`,
      );
    }

    const wasmHash = executable.wasmHash();
    const hash = Buffer.from(wasmHash).toString("hex");

    // Normalize to lowercase
    return hash.toLowerCase();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|could not (be )?found|missing/i.test(message)) {
      throw Object.assign(
        new Error(`contract ${contractId} not found on-chain`),
        { code: "not_found" as const },
      );
    }
    throw Object.assign(new Error(message), { code: "rpc_error" as const });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Backfill Logic
// ─────────────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<{ success: true; value: T } | { success: false; error: string }> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
        ),
      ]);
      return { success: true, value };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        if (verbose) console.log(`  Retry ${attempt}/${maxRetries - 1} after ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }

  return { success: false, error: lastError?.message || "unknown error" };
}

async function backfillRecord(
  record: VerificationRecordInternal,
  rpcUrl: string,
  db: ReturnType<typeof drizzle>,
  isDryRun: boolean,
): Promise<{ type: "success" | "skipped" | "failed"; error?: string }> {
  const { id, contractId, deployedHash } = record;

  // Skip if already populated
  if (deployedHash) {
    if (verbose) console.log(`  SKIP: ${id} (already has deployedHash)`);
    return { type: "skipped" };
  }

  // Fetch deployedHash from blockchain
  if (verbose) console.log(`  FETCH: ${id} (${contractId})`);
  const result = await withRetry(
    () => resolveDeployedHash(contractId, rpcUrl),
    MAX_RETRIES,
  );

  if (!result.success) {
    if (verbose) console.log(`  FAILED: ${id} — ${result.error}`);
    return { type: "failed", error: result.error };
  }

  const newHash = result.value;

  // Write to database (unless dry-run)
  if (!isDryRun) {
    try {
      // Re-fetch the current record to ensure we're not overwriting concurrent updates
      const current = await db
        .select({ record: verificationRecords.record })
        .from(verificationRecords)
        .where(eq(verificationRecords.id, id));

      if (!current || current.length === 0) {
        return { type: "failed", error: "record deleted concurrently" };
      }

      const currentRecord = current[0].record;

      // Skip if another process already backfilled it
      if (currentRecord.deployedHash) {
        if (verbose) console.log(`  SKIP: ${id} (backfilled by another process)`);
        return { type: "skipped" };
      }

      // Update with new deployedHash
      const updated: VerificationRecordInternal = { ...currentRecord, deployedHash: newHash };
      await db
        .update(verificationRecords)
        .set({
          record: updated,
          updatedAt: new Date(),
        })
        .where(eq(verificationRecords.id, id));

      if (verbose) console.log(`  WRITE: ${id} → ${newHash.substring(0, 8)}...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (verbose) console.log(`  WRITE FAILED: ${id} — ${msg}`);
      return { type: "failed", error: `write error: ${msg}` };
    }
  } else if (verbose) {
    console.log(`  DRY-RUN: Would write ${newHash.substring(0, 8)}... to ${id}`);
  }

  return { type: "success" };
}

async function fetchAffectedRows(
  db: ReturnType<typeof drizzle>,
  limit: number,
): Promise<VerificationRecordInternal[]> {
  const rows = await db.execute(
    sql`
      SELECT record FROM verification_records
      WHERE status = 'verified'
        AND (record->>'deployedHash' IS NULL OR record->>'deployedHash' = '')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `,
  );

  return (rows as any[]).map((row) => row.record as VerificationRecordInternal);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Verification Requests Metadata Backfill ===\n");
  console.log(`Mode: ${isDryRun ? "DRY-RUN (no writes)" : "CONFIRMED (will write)"}`);
  console.log(`Database: ${DATABASE_URL}`);
  console.log(`RPC: ${RPC_URL}\n`);

  // Connect to database
  let pool: pg.Pool | undefined;
  let db: ReturnType<typeof drizzle> | undefined;

  try {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool);

    // Run migrations
    console.log("Running migrations...");
    const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });
    console.log("Migrations complete.\n");

    // Count affected rows
    console.log("Scanning for affected rows...");
    const allRows = await db
      .select({ record: verificationRecords.record })
      .from(verificationRecords)
      .where(
        and(
          eq(verificationRecords.status, "verified"),
          sql`(${verificationRecords.record}->>'deployedHash' IS NULL OR ${verificationRecords.record}->>'deployedHash' = '')`,
        ),
      )
      .orderBy(verificationRecords.updatedAt);

    const records = allRows.map((r) => r.record);
    const stats: BackfillStats = {
      totalAffected: records.length,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      failedIds: [],
    };

    console.log(`Found ${stats.totalAffected} records with missing deployedHash.\n`);

    if (stats.totalAffected === 0) {
      console.log("✓ No records to backfill.");
      return;
    }

    // Show preview in dry-run
    if (isDryRun) {
      console.log("Preview (first 3 records):");
      for (const record of records.slice(0, 3)) {
        console.log(`  - ${record.id}: contract ${record.contractId}`);
      }
      if (stats.totalAffected > 3) {
        console.log(`  ... and ${stats.totalAffected - 3} more`);
      }
      console.log();
    }

    // Process in batches
    console.log("Processing records...");
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(records.length / BATCH_SIZE);

      console.log(`\nBatch ${batchNum}/${totalBatches}:`);

      for (const record of batch) {
        const result = await backfillRecord(record, RPC_URL, db!, isDryRun);

        if (result.type === "success") {
          stats.succeeded++;
        } else if (result.type === "skipped") {
          stats.skipped++;
        } else {
          stats.failed++;
          stats.failedIds.push({
            id: record.id,
            contractId: record.contractId,
            error: result.error || "unknown",
          });
        }

        // Rate-limit RPC calls
        if (record !== batch[batch.length - 1]) {
          await sleep(RPC_DELAY_MS);
        }
      }
    }

    // Print summary
    console.log("\n=== Summary ===");
    console.log(`Total affected: ${stats.totalAffected}`);
    console.log(`✓ Succeeded: ${stats.succeeded}`);
    console.log(`⊘ Skipped: ${stats.skipped}`);
    console.log(`✗ Failed: ${stats.failed}`);

    if (stats.failedIds.length > 0) {
      console.log("\nFailed records:");
      for (const failed of stats.failedIds) {
        console.log(`  - ${failed.id} (${failed.contractId}): ${failed.error}`);
      }
    }

    if (isDryRun) {
      console.log(
        "\n⚠ DRY-RUN: No changes written. Run with --confirm to apply changes.",
      );
    } else {
      console.log("\n✓ Backfill complete.");
    }

    process.exit(stats.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(
      "Fatal error:",
      err instanceof Error ? err.message : String(err),
    );
    if (verbose && err instanceof Error) {
      console.error(err.stack);
    }
    process.exit(2);
  } finally {
    if (db) {
      // Drizzle doesn't have a close method; close the pool directly
      if (pool) {
        await pool.end().catch(() => {});
      }
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(2);
});
