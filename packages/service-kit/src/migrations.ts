import { createHash } from "node:crypto";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

// Hash-based migration runner for a Postgres database SHARED by several services.
//
// wallet-, policy- and verification-service each ship an independent drizzle
// journal but, in the all-in-one deploy, migrate into ONE database and ONE
// drizzle.__drizzle_migrations table. drizzle's own migrator applies a migration
// only when its journal timestamp is newer than the NEWEST row in that table.
// With several interleaved journals that rule silently skips every service whose
// migrations are older than the last one another service recorded: booting
// wallet-service first on a fresh database leaves policy-service's `policies`
// and verification-service's `verification_records` tables uncreated. The same
// rule would also skip any older-dated migration promoted onto a database that
// already holds a newer one.
//
// This runner keeps drizzle's file format, hashing and bookkeeping table (rows
// stay readable by drizzle tooling, and rows drizzle already wrote count as
// applied) but decides by HASH: it applies each migration whose hash is not
// recorded, which is the question that actually matters in a shared table. On an
// existing database every already-recorded migration is skipped, so nothing
// re-runs.
//
// Two files with identical bytes share one hash, so they are applied once. The
// wallet and policy services rely on that for their identical 0001_spend_ledger
// migration (a test pins it); editing one without the other would make this
// runner try to create the table twice.
//
// Callers MUST hold the cross-service migration advisory lock (see each service's
// db/client.ts) so concurrent boots cannot interleave.

export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const BREAKPOINT = "--> statement-breakpoint";

/** drizzle hashes the raw file bytes, so the same migration checked out with CRLF
 * (Windows) and LF (Linux CI) line endings records different hashes. Treat either
 * form as applied so a database migrated from one checkout is not re-migrated
 * from the other. */
function recordedForms(migration: MigrationMeta): string[] {
  const raw = migration.sql.join(BREAKPOINT);
  const lf = raw.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  return [migration.hash, sha(lf), sha(crlf)];
}

/**
 * Apply every migration in `migrationsFolder` whose hash is not yet recorded, in
 * journal order, inside ONE transaction (all or nothing). Returns how many were
 * applied; 0 means the database was already up to date.
 */
export async function applyMigrations(
  client: MigrationClient,
  migrationsFolder: string,
): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
  const { rows } = await client.query(`SELECT hash FROM "drizzle"."__drizzle_migrations"`);
  const recorded = new Set(rows.map((r) => String(r.hash)));
  const pending = migrations.filter((m) => !recordedForms(m).some((h) => recorded.has(h)));
  if (pending.length === 0) return 0;

  await client.query("BEGIN");
  try {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return pending.length;
}
