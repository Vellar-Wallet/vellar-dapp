import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "@vellar/service-kit";

// The shared-database migration runner against REAL Postgres. wallet-, policy- and
// verification-service each ship their own drizzle journal but migrate into ONE
// database and ONE drizzle.__drizzle_migrations table. drizzle's own migrator only
// applies a migration newer than the newest row in that table, so interleaved
// journals silently skip whole services; applyMigrations() decides by HASH.
//
// Skipped locally unless TEST_DATABASE_URL is set; CI sets CI_REQUIRE_DB=1 so the
// suite fails instead of silently skipping (the RA-2 lesson).
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset: the shared-database migration guarantee would silently skip.",
  );
}

const folderOf = (service: string) =>
  fileURLToPath(new URL(`../../../${service}/drizzle`, import.meta.url));
const WALLET = folderOf("wallet-service");
const POLICY = folderOf("policy-service");
const VERIFICATION = folderOf("verification-service");

const EXPECTED_TABLES = [
  "activity_logs",
  "policies",
  "spend_ledger",
  "submission_replay",
  "verification_records",
  "wallet_sessions",
  "wallets",
];

describe.skipIf(!DATABASE_URL)("applyMigrations against a shared Postgres database", () => {
  let admin: pg.Client;
  const created: string[] = [];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
  });

  afterAll(async () => {
    for (const name of created) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
  });

  /** A brand-new empty database, as a new staging tier or a recreated one starts from. */
  async function freshDatabase(): Promise<{ pool: pg.Pool; name: string }> {
    const name = `vellar_mig_${Math.random().toString(36).slice(2, 10)}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = new URL(DATABASE_URL as string);
    url.pathname = `/${name}`;
    return { pool: new pg.Pool({ connectionString: url.toString() }), name };
  }

  async function tables(pool: pg.Pool): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return rows.map((r) => String(r.table_name));
  }

  async function recordedRows(pool: pg.Pool): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`,
    );
    return Number(rows[0].n);
  }

  /** Apply a folder through a dedicated client, the way each service's connectDb does. */
  async function apply(pool: pg.Pool, folder: string): Promise<number> {
    const client = await pool.connect();
    try {
      return await applyMigrations(client, folder);
    } finally {
      client.release();
    }
  }

  it("REPRODUCES the bug: drizzle's own migrator leaves policy and verification tables uncreated", async () => {
    const { pool } = await freshDatabase();
    try {
      // Boot order of the all-in-one process: wallet-service first.
      await migrate(drizzle(pool), { migrationsFolder: WALLET });
      await migrate(drizzle(pool), { migrationsFolder: POLICY });
      await migrate(drizzle(pool), { migrationsFolder: VERIFICATION });

      const have = await tables(pool);
      expect(have).toContain("wallets");
      // The older journals are skipped by the timestamp rule.
      expect(have).not.toContain("policies");
      expect(have).not.toContain("verification_records");
    } finally {
      await pool.end();
    }
  });

  it.each([
    ["wallet, policy, verification", [WALLET, POLICY, VERIFICATION]],
    ["verification, policy, wallet", [VERIFICATION, POLICY, WALLET]],
    ["policy, wallet, verification", [POLICY, WALLET, VERIFICATION]],
  ])(
    "on a fresh database every service's tables are created, in the order: %s",
    async (_label, order) => {
      const { pool } = await freshDatabase();
      try {
        for (const folder of order) await apply(pool, folder);

        expect(await tables(pool)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
      } finally {
        await pool.end();
      }
    },
  );

  it("the shared spend_ledger migration is recorded once, and a second boot applies nothing", async () => {
    const { pool } = await freshDatabase();
    try {
      for (const folder of [WALLET, POLICY, VERIFICATION]) await apply(pool, folder);
      const rows = await recordedRows(pool);

      expect(await apply(pool, WALLET)).toBe(0);
      expect(await apply(pool, POLICY)).toBe(0);
      expect(await apply(pool, VERIFICATION)).toBe(0);
      expect(await recordedRows(pool)).toBe(rows);
      // wallet 0000-0003 + policy 0000 + verification 0000 = 6 distinct files
      // (policy's 0001 is byte-identical to wallet's 0001, so it is the same row).
      expect(rows).toBe(6);
    } finally {
      await pool.end();
    }
  });

  it("an existing database written by drizzle's migrator is NOT re-migrated (upgrade safety)", async () => {
    const { pool } = await freshDatabase();
    try {
      await migrate(drizzle(pool), { migrationsFolder: WALLET }); // rows recorded by drizzle
      const before = await recordedRows(pool);

      const applied = await apply(pool, WALLET);

      expect(applied).toBe(0);
      expect(await recordedRows(pool)).toBe(before);
    } finally {
      await pool.end();
    }
  });

  it("applies what the timestamp rule skipped on a database drizzle already migrated", async () => {
    const { pool } = await freshDatabase();
    try {
      await migrate(drizzle(pool), { migrationsFolder: WALLET });
      expect(await tables(pool)).not.toContain("policies");

      expect(await apply(pool, POLICY)).toBeGreaterThan(0);

      expect(await tables(pool)).toContain("policies");
    } finally {
      await pool.end();
    }
  });

  it("two services booting at once under the shared advisory lock: no error, nothing applied twice", async () => {
    const { pool } = await freshDatabase();
    const LOCK = 0x56454c41; // the same key every service's connectDb uses
    const bootOne = async (folder: string) => {
      const conn = await pool.connect();
      try {
        await conn.query("SELECT pg_advisory_lock($1)", [LOCK]);
        return await applyMigrations(conn, folder);
      } finally {
        await conn.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
        conn.release();
      }
    };
    try {
      await Promise.all([bootOne(WALLET), bootOne(POLICY), bootOne(VERIFICATION)]);

      expect(await tables(pool)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
      expect(await recordedRows(pool)).toBe(6);
    } finally {
      await pool.end();
    }
  });

  it("a failing migration rolls back the whole batch and records nothing", async () => {
    const { pool } = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), "vellar-mig-pg-"));
    mkdirSync(join(dir, "meta"));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1, tag: "0000_ok", breakpoints: true },
          { idx: 1, version: "7", when: 2, tag: "0001_bad", breakpoints: true },
        ],
      }),
    );
    writeFileSync(join(dir, "0000_ok.sql"), 'CREATE TABLE "ok_table" (id int);');
    writeFileSync(join(dir, "0001_bad.sql"), "CREATE TABLE this is not sql;");
    try {
      await expect(apply(pool, dir)).rejects.toBeDefined();

      expect(await tables(pool)).not.toContain("ok_table");
      expect(await recordedRows(pool)).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
