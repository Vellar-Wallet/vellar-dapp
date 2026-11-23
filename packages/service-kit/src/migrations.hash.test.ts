import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";

// Pins the hash algorithm the migration runner relies on (see the header of
// migrations.ts). It runs against the REAL drizzle `readMigrationFiles`, so an
// upgrade or change that alters how migrations are hashed (a different digest,
// truncation, hashing something other than the file bytes) fails here and has
// to be handled on purpose, instead of silently changing which migrations the
// runner believes are already applied.

const folders: string[] = [];

function migrationsFolder(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "vellar-migrations-"));
  folders.push(folder);
  mkdirSync(join(folder, "meta"));
  const entries = Object.keys(files).map((tag, idx) => ({
    idx,
    version: "7",
    when: 1_700_000_000_000 + idx * 1000,
    tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  for (const [tag, sql] of Object.entries(files)) writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("migration hash algorithm", () => {
  const sql = 'CREATE TABLE "a" (\n  "id" integer\n);\n--> statement-breakpoint\nSELECT 1;\n';

  it("is the full, untruncated SHA-256 hex digest of the raw .sql file contents", () => {
    const [migration] = readMigrationFiles({
      migrationsFolder: migrationsFolder({ "0000_a": sql }),
    });

    expect(migration?.hash).toBe(createHash("sha256").update(sql).digest("hex"));
    expect(migration?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single byte of the file changes", () => {
    const [original] = readMigrationFiles({
      migrationsFolder: migrationsFolder({ "0000_a": sql }),
    });
    const [edited] = readMigrationFiles({
      migrationsFolder: migrationsFolder({ "0000_a": sql.replace("integer", "bigint") }),
    });

    expect(edited?.hash).not.toBe(original?.hash);
  });

  it("hashes the raw bytes, so CRLF and LF checkouts of one file hash differently", () => {
    const [lf] = readMigrationFiles({ migrationsFolder: migrationsFolder({ "0000_a": sql }) });
    const [crlf] = readMigrationFiles({
      migrationsFolder: migrationsFolder({ "0000_a": sql.replace(/\n/g, "\r\n") }),
    });

    // This is exactly why the runner also checks the LF/CRLF-normalized forms.
    expect(crlf?.hash).not.toBe(lf?.hash);
  });

  it("gives every migration of a journal its own hash, in journal order", () => {
    const migrations = readMigrationFiles({
      migrationsFolder: migrationsFolder({
        "0000_a": "CREATE TABLE a (id int);",
        "0001_b": "CREATE TABLE b (id int);",
      }),
    });

    expect(migrations.map((m) => m.folderMillis)).toEqual([1_700_000_000_000, 1_700_000_001_000]);
    expect(new Set(migrations.map((m) => m.hash)).size).toBe(2);
  });
});
