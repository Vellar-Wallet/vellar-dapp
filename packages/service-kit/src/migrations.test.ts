import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationMeta } from "drizzle-orm/migrator";

// `readMigrationFiles` is replaced so each test can hand the runner an exact set
// of migrations (including ones whose hashes collide).
const { readMigrationFiles } = vi.hoisted(() => ({ readMigrationFiles: vi.fn() }));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles }));

import {
  MigrationHashCollisionError,
  applyMigrations,
  assertNoHashCollisions,
  type MigrationClient,
} from "./migrations";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A migration shaped like drizzle's own: hash = sha256 of the raw file text. */
function migration(sql: string[], folderMillis: number, hash?: string): MigrationMeta {
  return {
    sql,
    bps: true,
    folderMillis,
    hash: hash ?? sha256(sql.join("--> statement-breakpoint")),
  };
}

/** A fake Postgres client that records every statement and the recorded hashes. */
function fakeClient(recordedHashes: string[] = []) {
  const statements: string[] = [];
  const inserted: Array<{ hash: string; createdAt: number }> = [];
  const client: MigrationClient = {
    async query(text, params) {
      statements.push(text.trim().split("\n")[0]!.trim());
      if (text.includes("SELECT hash")) {
        return { rows: recordedHashes.map((hash) => ({ hash })) };
      }
      if (text.includes("INSERT INTO")) {
        inserted.push({ hash: String(params?.[0]), createdAt: Number(params?.[1]) });
      }
      return { rows: [] };
    },
  };
  return { client, statements, inserted };
}

beforeEach(() => {
  readMigrationFiles.mockReset();
});

describe("applyMigrations — normal operation", () => {
  it("applies every unrecorded migration in journal order and records each hash", async () => {
    const first = migration(["CREATE TABLE a (id int)"], 1000);
    const second = migration(["CREATE TABLE b (id int)", "CREATE INDEX b_idx ON b (id)"], 2000);
    readMigrationFiles.mockReturnValue([first, second]);
    const { client, statements, inserted } = fakeClient();

    await expect(applyMigrations(client, "/migrations")).resolves.toBe(2);

    expect(inserted).toEqual([
      { hash: first.hash, createdAt: 1000 },
      { hash: second.hash, createdAt: 2000 },
    ]);
    expect(statements).toContain("CREATE TABLE a (id int)");
    expect(statements.indexOf("CREATE TABLE a (id int)")).toBeLessThan(
      statements.indexOf("CREATE TABLE b (id int)"),
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("skips migrations whose hash is already recorded", async () => {
    const applied = migration(["CREATE TABLE a (id int)"], 1000);
    const pending = migration(["CREATE TABLE b (id int)"], 2000);
    readMigrationFiles.mockReturnValue([applied, pending]);
    const { client, statements } = fakeClient([applied.hash]);

    await expect(applyMigrations(client, "/migrations")).resolves.toBe(1);

    expect(statements).not.toContain("CREATE TABLE a (id int)");
    expect(statements).toContain("CREATE TABLE b (id int)");
  });

  it("does nothing when everything is recorded", async () => {
    const only = migration(["CREATE TABLE a (id int)"], 1000);
    readMigrationFiles.mockReturnValue([only]);
    const { client, statements } = fakeClient([only.hash]);

    await expect(applyMigrations(client, "/migrations")).resolves.toBe(0);
    expect(statements).not.toContain("BEGIN");
  });

  it("treats a migration recorded under the other line-ending form as already applied", async () => {
    const lf = migration(["CREATE TABLE a (\n  id int\n)"], 1000);
    const crlfHash = sha256("CREATE TABLE a (\r\n  id int\r\n)");
    readMigrationFiles.mockReturnValue([lf]);
    const { client } = fakeClient([crlfHash]);

    await expect(applyMigrations(client, "/migrations")).resolves.toBe(0);
  });
});

describe("applyMigrations — colliding hashes (#757)", () => {
  const sharedHash = "a".repeat(64);
  const first = () => migration(["CREATE TABLE a (id int)"], 1000, sharedHash);
  const second = () => migration(["CREATE TABLE b (id int)"], 2000, sharedHash);

  it("refuses two distinct migrations that share a hash, naming both and the hash", async () => {
    readMigrationFiles.mockReturnValue([first(), second()]);
    const { client } = fakeClient();

    const error = await applyMigrations(client, "/migrations").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationHashCollisionError);
    const collision = error as MigrationHashCollisionError;
    expect(collision.hash).toBe(sharedHash);
    expect(collision.folderMillis).toEqual([1000, 2000]);
    expect(collision.message).toContain("1000");
    expect(collision.message).toContain("2000");
    expect(collision.message).toContain(sharedHash);
  });

  it("fails before running a single query, so nothing is half-applied", async () => {
    readMigrationFiles.mockReturnValue([first(), second()]);
    const { client, statements } = fakeClient();

    await expect(applyMigrations(client, "/migrations")).rejects.toBeInstanceOf(
      MigrationHashCollisionError,
    );
    expect(statements).toEqual([]);
  });

  it("still refuses when the first of the two is already recorded (the silent-skip case)", async () => {
    // Without the guard the second migration would look applied because its hash
    // matches the first one's row, and would never run.
    readMigrationFiles.mockReturnValue([first(), second()]);
    const { client, statements } = fakeClient([sharedHash]);

    await expect(applyMigrations(client, "/migrations")).rejects.toBeInstanceOf(
      MigrationHashCollisionError,
    );
    expect(statements).toEqual([]);
  });

  it("detects the collision wherever the two migrations sit in the journal", async () => {
    const middle = migration(["CREATE TABLE m (id int)"], 1500);
    readMigrationFiles.mockReturnValue([first(), middle, second()]);
    const { client } = fakeClient();

    await expect(applyMigrations(client, "/migrations")).rejects.toThrow(/1000 and 2000/);
  });

  it("detects duplicates that differ only by line endings", async () => {
    // Different raw bytes (different drizzle hashes), same migration once
    // line endings are normalized — the runner would treat them as one.
    const lf = migration(["CREATE TABLE a (\n  id int\n)"], 1000);
    const crlf = migration(["CREATE TABLE a (\r\n  id int\r\n)"], 2000);
    expect(lf.hash).not.toBe(crlf.hash);
    readMigrationFiles.mockReturnValue([lf, crlf]);
    const { client } = fakeClient();

    await expect(applyMigrations(client, "/migrations")).rejects.toBeInstanceOf(
      MigrationHashCollisionError,
    );
  });

  it("does not raise a false alarm for distinct migrations", async () => {
    readMigrationFiles.mockReturnValue([
      migration(["CREATE TABLE a (id int)"], 1000),
      migration(["CREATE TABLE b (id int)"], 2000),
      migration(["CREATE TABLE c (id int)"], 3000),
    ]);
    const { client } = fakeClient();

    await expect(applyMigrations(client, "/migrations")).resolves.toBe(3);
  });
});

describe("assertNoHashCollisions", () => {
  it("passes for an empty list, a single migration and distinct migrations", () => {
    expect(() => assertNoHashCollisions([])).not.toThrow();
    expect(() => assertNoHashCollisions([migration(["SELECT 1"], 1)])).not.toThrow();
    expect(() =>
      assertNoHashCollisions([migration(["SELECT 1"], 1), migration(["SELECT 2"], 2)]),
    ).not.toThrow();
  });

  it("does not treat a migration as colliding with itself (LF and CRLF forms coincide)", () => {
    // No newlines: the LF and CRLF forms are the same string as each other.
    expect(() => assertNoHashCollisions([migration(["SELECT 1"], 1)])).not.toThrow();
  });

  it("throws for the same migration listed twice under different journal timestamps", () => {
    const sql = ["CREATE TABLE a (id int)"];
    expect(() =>
      assertNoHashCollisions([migration(sql, 1000), migration(sql, 2000)]),
    ).toThrow(MigrationHashCollisionError);
  });
});
