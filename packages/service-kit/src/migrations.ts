import { createHash } from "node:crypto";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

// Hash-based migration runner for a Postgres database SHARED by several
// services (issue #418 — found by booting the full stack against a fresh
// database, which is what a new staging tier, or a recreated free-tier
// production database, starts from).
//
// wallet-, policy- and verification-service each ship an independent drizzle
// journal but, in the all-in-one deploy, migrate into ONE database and ONE
// drizzle.__drizzle_migrations table. drizzle's migrator applies a migration
// only when its journal timestamp is newer than the NEWEST row in that table.
// With three interleaved journals that rule silently skips every service whose
// migrations are older than the last one another service recorded: on a fresh
// database, booting wallet-service first left policy-service's `policies` and
// verification-service's `verification_records` tables uncreated.
//
// This runner keeps drizzle's file format, hashing and bookkeeping table (rows
// stay readable by drizzle tooling) but applies each migration whose HASH is
// not recorded — the question that actually matters in a shared table. On an
// existing database every already-recorded migration is skipped, so nothing
// re-runs; a migration that the timestamp rule skipped is applied.
//
// Callers must hold the cross-service migration advisory lock (see each
// service's db/client.ts) so concurrent boots cannot interleave.
//
// Hash algorithm (pinned by migrations.hash.test.ts, so changing it is a
// deliberate act): a migration's identity is the SHA-256 of the raw bytes of
// its `.sql` file, hex-encoded and NOT truncated (64 characters). drizzle's
// `readMigrationFiles` computes it; this runner additionally treats the
// LF-normalized and CRLF-normalized forms of the same SQL as the same
// migration (see `recordedForms`). Because "already recorded" is decided by
// hash alone, two DIFFERENT migrations sharing a hash would make one of them
// look applied and be skipped forever. A SHA-256 collision between real files
// is not a practical risk, but it becomes one the moment the hash is shortened
// or swapped for a weaker one, and duplicate files that differ only by line
// endings collide by design. `applyMigrations` therefore refuses to run at all
// (before any query) when two migrations in the folder share a hash, via
// `assertNoHashCollisions` below. It only sees one folder per call, so it
// cannot catch a collision between two services' folders in the shared table.

export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const BREAKPOINT = "--> statement-breakpoint";

/** drizzle hashes the raw file bytes, so the same migration checked out with
 * CRLF (Windows) and LF (CI/Render) line endings records different hashes.
 * Treat either form as applied so a database migrated from one checkout is not
 * re-migrated from the other. */
function recordedForms(migration: MigrationMeta): string[] {
  const raw = migration.sql.join(BREAKPOINT);
  const lf = raw.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  return [migration.hash, sha(lf), sha(crlf)];
}

/** Thrown when two different migrations in one folder resolve to the same hash. */
export class MigrationHashCollisionError extends Error {
  constructor(
    readonly hash: string,
    /** Journal timestamps (`when`) of the two migrations that collide. */
    readonly folderMillis: readonly [number, number],
  ) {
    super(
      `Migration hash collision: the migrations at journal timestamps ${folderMillis[0]} and ` +
        `${folderMillis[1]} both hash to ${hash}. Refusing to run, because the runner decides ` +
        "'already applied' by hash alone, so one of them would be silently skipped or the " +
        "order would be undefined. Make the two migration files differ (or remove the duplicate).",
    );
    this.name = "MigrationHashCollisionError";
  }
}

/** Throws {@link MigrationHashCollisionError} when two distinct migrations share a hash
 * (in any of the forms the runner treats as the same migration). */
export function assertNoHashCollisions(migrations: readonly MigrationMeta[]): void {
  const owner = new Map<string, MigrationMeta>();
  for (const migration of migrations) {
    for (const form of recordedForms(migration)) {
      const previous = owner.get(form);
      if (previous !== undefined && previous !== migration) {
        throw new MigrationHashCollisionError(form, [
          previous.folderMillis,
          migration.folderMillis,
        ]);
      }
      owner.set(form, migration);
    }
  }
}

/** Apply every migration in `migrationsFolder` whose hash is not yet recorded,
 * in journal order, inside one transaction. Returns how many were applied. */
export async function applyMigrations(
  client: MigrationClient,
  migrationsFolder: string,
): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder });
  // Before any query: a collision must never leave a half-migrated database.
  assertNoHashCollisions(migrations);
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
