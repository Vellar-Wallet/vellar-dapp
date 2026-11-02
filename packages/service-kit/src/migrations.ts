import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface PendingMigration {
  /** The journal tag, for example `0003_submission_replay`. */
  tag: string;
  hash: string;
  folderMillis: number;
  /** Tables the migration's CREATE TABLE statements name. */
  createsTables: string[];
}

interface RecordedRow {
  hash: string;
  createdAt: number | undefined;
}

/** Rows already in the bookkeeping table. Read-only: it creates nothing, so it is safe
 * against a database that has never been migrated or that must not be written to. */
async function readRecorded(client: MigrationClient): Promise<RecordedRow[]> {
  const { rows: reg } = await client.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations') AS reg`,
  );
  if (reg[0]?.reg == null) return [];
  const { rows } = await client.query(
    `SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"`,
  );
  return rows.map((r) => ({
    hash: String(r.hash),
    createdAt: r.created_at == null ? undefined : Number(r.created_at),
  }));
}

function journalTags(migrationsFolder: string): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  return (journal.entries as Array<{ tag: string }>).map((e) => e.tag);
}

function createdTables(migration: MigrationMeta): string[] {
  const sql = migration.sql.join("\n");
  return [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)].map(
    (m) => m[1]!,
  );
}

function toPending(migrations: MigrationMeta[], tags: string[]): PendingMigration[] {
  return migrations.map((m, i) => ({
    tag: tags[i] ?? `#${i}`,
    hash: m.hash,
    folderMillis: m.folderMillis,
    createsTables: createdTables(m),
  }));
}

/**
 * The migrations in `migrationsFolder` that this runner WOULD apply, in journal order.
 * Strictly read-only: no DDL, no INSERT, no transaction.
 */
export async function pendingMigrations(
  client: MigrationClient,
  migrationsFolder: string,
): Promise<PendingMigration[]> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const recorded = new Set((await readRecorded(client)).map((r) => r.hash));
  const tags = journalTags(migrationsFolder);
  return toPending(migrations, tags).filter(
    (_, i) => !recordedForms(migrations[i]!).some((h) => recorded.has(h)),
  );
}

export type PendingClassification =
  /** Nothing in the database suggests it was ever applied. Safe to apply. */
  | "new"
  /** Not recorded, but a table it creates already exists: created outside the journal. */
  | "table-exists-unrecorded"
  /** A row with the SAME timestamp but a DIFFERENT hash is recorded: the file changed after it was applied. */
  | "edited-after-apply";

export interface DescribedMigration extends PendingMigration {
  classification: PendingClassification;
  /** Tables it would create that already exist in the database. */
  existingTables: string[];
  recordedHashAtSameTime?: string;
}

/** One journal file the planner looked at, and whether a recorded hash matched it. */
export interface ConsideredMigration {
  tag: string;
  hash: string;
  folderMillis: number;
  recorded: boolean;
}

export interface MigrationPlan {
  /** EVERY file in the folder's journal, in order, with whether a recorded hash matched it. */
  considered: ConsideredMigration[];
  /** The raw recorded rows (hash, created_at), for explaining rows no file matches. */
  recordedRows: Array<{ hash: string; createdAt: number | undefined }>;
  pending: DescribedMigration[];
  /** Pending migrations that are NOT plainly new: the runner must not be switched on until explained. */
  blockers: DescribedMigration[];
  recordedCount: number;
  /** Recorded rows with no matching file in this folder (applied by something else, or an older checkout). */
  recordedNotOnDisk: number;
}

/** `pendingMigrations` plus an explanation of why each is pending. Read-only. */
export async function describePlan(
  client: MigrationClient,
  migrationsFolder: string,
): Promise<MigrationPlan> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const recorded = await readRecorded(client);
  const recordedHashes = new Set(recorded.map((r) => r.hash));
  const tags = journalTags(migrationsFolder);
  const all = toPending(migrations, tags);
  const isPending = (i: number) =>
    !recordedForms(migrations[i]!).some((h) => recordedHashes.has(h));

  const wanted = [...new Set(all.filter((_, i) => isPending(i)).flatMap((p) => p.createsTables))];
  let existing = new Set<string>();
  if (wanted.length > 0) {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [wanted],
    );
    existing = new Set(rows.map((r) => String(r.table_name)));
  }

  const pending: DescribedMigration[] = [];
  all.forEach((p, i) => {
    if (!isPending(i)) return;
    const existingTables = p.createsTables.filter((t) => existing.has(t));
    const sameTime = recorded.find((r) => r.createdAt === p.folderMillis);
    let classification: PendingClassification = "new";
    if (sameTime) classification = "edited-after-apply";
    else if (existingTables.length > 0) classification = "table-exists-unrecorded";
    pending.push({
      ...p,
      classification,
      existingTables,
      ...(sameTime ? { recordedHashAtSameTime: sameTime.hash } : {}),
    });
  });

  const onDisk = new Set(migrations.flatMap((m) => recordedForms(m)));
  return {
    considered: all.map((p, i) => ({
      tag: p.tag,
      hash: p.hash,
      folderMillis: p.folderMillis,
      recorded: !isPending(i),
    })),
    recordedRows: recorded,
    pending,
    blockers: pending.filter((p) => p.classification !== "new"),
    recordedCount: recorded.length,
    recordedNotOnDisk: recorded.filter((r) => !onDisk.has(r.hash)).length,
  };
}

export interface ApplyOptions {
  /** List what would be applied and apply nothing: no DDL, no INSERT, no transaction. */
  dryRun?: boolean;
}

/**
 * Apply every migration in `migrationsFolder` whose hash is not yet recorded, in
 * journal order, inside ONE transaction (all or nothing). Returns how many were
 * applied; 0 means the database was already up to date. With `dryRun` it returns
 * how many WOULD be applied and changes nothing (see `pendingMigrations`).
 */
export async function applyMigrations(
  client: MigrationClient,
  migrationsFolder: string,
  options: ApplyOptions = {},
): Promise<number> {
  if (options.dryRun) return (await pendingMigrations(client, migrationsFolder)).length;

  const migrations = readMigrationFiles({ migrationsFolder });
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
  const recorded = new Set((await readRecorded(client)).map((r) => r.hash));
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
