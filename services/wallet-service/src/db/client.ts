import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { applyMigrations, deployEnvFromEnv, ensureDeploymentMarker } from "@vellar/service-kit";

export type Db = NodePgDatabase;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
  /** Cheap liveness check for the DB-aware /health probe (FIX 7). Resolves true
   * when the pool can round-trip a query, false when the connection is down —
   * so /health returns 503 if Postgres drops AFTER boot, not just at boot. */
  ping(): Promise<boolean>;
}

/** Advisory-lock key shared by ALL Vellar services' db clients: every migrator
 * hitting one database must serialize globally, because concurrent CREATE TABLE
 * (including drizzle's own IF NOT EXISTS journal bootstrap) aborts with 23505
 * on pg_type_typname_nsp_index even though each migration runs in its own
 * transaction. Covers parallel vitest workers in CI and multi-replica boots. */
const MIGRATION_LOCK_KEY = 0x56454c41; // "VELA"

/** Connects and applies pending migrations (idempotent) before returning. */
export async function connectDb(databaseUrl: string): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  // Session-level lock on a dedicated connection: pg_advisory_lock blocks
  // until any concurrent migrator finishes, then we migrate and release.
  const lockConn = await pool.connect();
  let ready = false;
  try {
    await lockConn.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    // Refuse a database that belongs to the other tier BEFORE migrating or reading it.
    await ensureDeploymentMarker(lockConn, deployEnvFromEnv(process.env), process.env);
    // Hash-based, not drizzle's newest-timestamp rule: the migrations table is
    // shared with the other services in one database (see service-kit
    // migrations.ts: the timestamp rule silently skipped whole services).
    await applyMigrations(lockConn, fileURLToPath(new URL("../../drizzle", import.meta.url)));
    ready = true;
  } finally {
    await lockConn.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    lockConn.release();
    // A refused database (tier marker) or a failed migration must not leak the pool.
    if (!ready) await pool.end().catch(() => {});
  }
  return {
    db,
    close: () => pool.end(),
    ping: async () => {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
