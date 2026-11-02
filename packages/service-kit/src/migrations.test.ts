import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, type MigrationClient } from "./migrations";

// The hash-based migration runner for a Postgres database SHARED by several
// services. drizzle's own migrator applies a migration only when its timestamp is
// newer than the newest row in the (shared) bookkeeping table, so interleaved
// journals silently skip whole services. These tests use a recording fake client
// and temporary drizzle folders; migrations.pg.test.ts runs the real thing
// against Postgres.

interface Entry {
  tag: string;
  when: number;
  sql: string;
}

/** A drizzle migrations folder on disk: meta/_journal.json plus <tag>.sql files. */
function folder(entries: Entry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vellar-mig-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((e, idx) => ({
        idx,
        version: "7",
        when: e.when,
        tag: e.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
  return dir;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Recording fake: remembers every statement, and the hashes it has "stored". */
function fakeClient(opts: { recorded?: string[]; failOn?: RegExp } = {}) {
  const queries: string[] = [];
  const inserted: Array<{ hash: string; createdAt: number }> = [];
  const recorded = [...(opts.recorded ?? [])];
  const client: MigrationClient = {
    async query(text, params) {
      queries.push(text);
      if (opts.failOn?.test(text)) throw new Error(`boom: ${text.slice(0, 30)}`);
      if (/to_regclass/i.test(text)) return { rows: [{ reg: "drizzle.__drizzle_migrations" }] };
      if (/SELECT hash(, created_at)? FROM/i.test(text))
        return { rows: recorded.map((hash) => ({ hash })) };
      if (/INSERT INTO "drizzle"\."__drizzle_migrations"/i.test(text)) {
        inserted.push({ hash: String(params?.[0]), createdAt: Number(params?.[1]) });
        recorded.push(String(params?.[0]));
      }
      return { rows: [] };
    },
  };
  return { client, queries, inserted };
}

const A: Entry = { tag: "0000_a", when: 1_000, sql: 'CREATE TABLE "a" (id int);' };
const B: Entry = { tag: "0001_b", when: 2_000, sql: 'CREATE TABLE "b" (id int);' };

describe("applyMigrations", () => {
  it("creates the bookkeeping schema and table when they are missing", async () => {
    const { client, queries } = fakeClient();
    await applyMigrations(client, folder([A]));
    expect(queries.some((q) => /CREATE SCHEMA IF NOT EXISTS "drizzle"/.test(q))).toBe(true);
    expect(
      queries.some((q) => /CREATE TABLE IF NOT EXISTS "drizzle"\."__drizzle_migrations"/.test(q)),
    ).toBe(true);
  });

  it("applies every pending migration in journal order and records hash plus folder time", async () => {
    const { client, queries, inserted } = fakeClient();

    const applied = await applyMigrations(client, folder([A, B]));

    expect(applied).toBe(2);
    expect(queries.indexOf(A.sql)).toBeGreaterThan(-1);
    expect(queries.indexOf(A.sql)).toBeLessThan(queries.indexOf(B.sql));
    expect(inserted).toEqual([
      { hash: sha(A.sql), createdAt: A.when },
      { hash: sha(B.sql), createdAt: B.when },
    ]);
  });

  it("runs all pending migrations inside ONE transaction", async () => {
    const { client, queries } = fakeClient();
    await applyMigrations(client, folder([A, B]));
    const begin = queries.indexOf("BEGIN");
    const commit = queries.indexOf("COMMIT");
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(queries.indexOf(B.sql));
    expect(begin).toBeLessThan(queries.indexOf(A.sql));
    expect(queries.filter((q) => q === "BEGIN")).toHaveLength(1);
  });

  it("skips a migration whose hash is already recorded (an existing database re-runs nothing)", async () => {
    const { client, queries } = fakeClient({ recorded: [sha(A.sql), sha(B.sql)] });

    const applied = await applyMigrations(client, folder([A, B]));

    expect(applied).toBe(0);
    expect(queries).not.toContain("BEGIN");
    expect(queries).not.toContain(A.sql);
    expect(queries).not.toContain(B.sql);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const { client } = fakeClient();
    const dir = folder([A, B]);
    expect(await applyMigrations(client, dir)).toBe(2);
    expect(await applyMigrations(client, dir)).toBe(0);
  });

  // THE shared-database bug. Another service already recorded a NEWER migration.
  // drizzle's timestamp rule would skip A and B (both older); the hash rule must not.
  it("applies a migration that is OLDER than the newest recorded row from another service", async () => {
    const otherServiceNewer = sha("CREATE TABLE other (id int);");
    const { client, inserted } = fakeClient({ recorded: [otherServiceNewer] });

    const applied = await applyMigrations(client, folder([A, B]));

    expect(applied).toBe(2);
    expect(inserted.map((i) => i.hash)).toEqual([sha(A.sql), sha(B.sql)]);
  });

  it("applies only the migrations that are missing when some are recorded", async () => {
    const { client, queries } = fakeClient({ recorded: [sha(A.sql)] });

    const applied = await applyMigrations(client, folder([A, B]));

    expect(applied).toBe(1);
    expect(queries).not.toContain(A.sql);
    expect(queries).toContain(B.sql);
  });

  describe("line endings (a database migrated from a Windows checkout is not re-migrated on Linux)", () => {
    const multi = { tag: "0000_multi", when: 5_000, sql: 'CREATE TABLE "m" (\n  id int\n);\n' };

    it("treats a row recorded from the CRLF form as applied", async () => {
      const crlf = multi.sql.replace(/\n/g, "\r\n");
      const { client } = fakeClient({ recorded: [sha(crlf)] });
      expect(await applyMigrations(client, folder([multi]))).toBe(0);
    });

    it("treats a row recorded from the LF form as applied", async () => {
      const { client } = fakeClient({ recorded: [sha(multi.sql)] });
      expect(await applyMigrations(client, folder([multi]))).toBe(0);
    });
  });

  describe("a file with several statements", () => {
    const multi: Entry = {
      tag: "0000_multi",
      when: 7_000,
      sql: 'CREATE TABLE "x" (id int);\n--> statement-breakpoint\nCREATE INDEX "x_idx" ON "x" ("id");',
    };

    it("runs each statement separately and records ONE hash for the whole file", async () => {
      const { client, queries, inserted } = fakeClient();

      await applyMigrations(client, folder([multi]));

      expect(queries).toContain('CREATE TABLE "x" (id int);\n');
      expect(queries).toContain('\nCREATE INDEX "x_idx" ON "x" ("id");');
      // drizzle hashes the raw file text, breakpoint marker included.
      expect(inserted).toEqual([{ hash: sha(multi.sql), createdAt: 7_000 }]);
    });
  });

  describe("failure", () => {
    it("rolls back, records NOTHING and rethrows when a statement fails", async () => {
      const { client, queries, inserted } = fakeClient({ failOn: /CREATE TABLE "b"/ });

      await expect(applyMigrations(client, folder([A, B]))).rejects.toThrow(/boom/);

      expect(queries).toContain("ROLLBACK");
      expect(queries).not.toContain("COMMIT");
      // A ran inside the same transaction as B, so a failure leaves neither
      // half-applied; whatever was inserted before the failure is rolled back by
      // the database, and nothing is committed.
      expect(inserted.map((i) => i.hash)).not.toContain(sha(B.sql));
    });

    it("a failed run is retried from scratch next time (nothing was committed)", async () => {
      const flaky = fakeClient({ failOn: /CREATE TABLE "b"/ });
      await expect(applyMigrations(flaky.client, folder([A, B]))).rejects.toThrow();
      expect(flaky.queries).not.toContain("COMMIT");
    });

    it("an empty journal applies nothing and does not open a transaction", async () => {
      const { client, queries } = fakeClient();
      expect(await applyMigrations(client, folder([]))).toBe(0);
      expect(queries).not.toContain("BEGIN");
    });

    it("a missing folder throws instead of silently doing nothing", async () => {
      const { client } = fakeClient();
      await expect(
        applyMigrations(client, join(tmpdir(), "vellar-no-such-folder")),
      ).rejects.toThrow();
    });
  });
});

// The wallet and policy services both ship a 0001_spend_ledger migration into the
// SAME database. They only coexist because the two files are byte-identical, so
// their hashes match and the second service sees it as already applied. Editing
// one without the other would make the runner try to CREATE TABLE spend_ledger
// twice and fail at boot.
describe("shared spend_ledger migration", () => {
  it("is byte-identical in wallet-service and policy-service", () => {
    const read = (service: string) =>
      readFileSync(
        new URL(`../../../services/${service}/drizzle/0001_spend_ledger.sql`, import.meta.url),
      );
    expect(read("wallet-service").equals(read("policy-service"))).toBe(true);
  });
});

// A service whose client still calls drizzle's own migrator silently reintroduces
// the skip-whole-services bug, and nothing else would notice. Pin every client.
describe("every database client uses the shared-database runner", () => {
  it.each(["wallet-service", "policy-service", "verification-service"])(
    "%s migrates with applyMigrations and never with drizzle's timestamp migrator",
    (service) => {
      const source = readFileSync(
        new URL(`../../../services/${service}/src/db/client.ts`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("applyMigrations(");
      expect(source).not.toMatch(/drizzle-orm\/node-postgres\/migrator/);
      expect(source).not.toMatch(/\bmigrate\(/);
    },
  );
});

// ---------------------------------------------------------------------------
// Dry run: list what WOULD be applied, apply nothing, write nothing. Used to check a
// production database before switching it to this runner.
// ---------------------------------------------------------------------------
import { describePlan, pendingMigrations } from "./migrations";

interface Row {
  hash: string;
  created_at: number;
}

/** A recording client that serves only the read-only queries the planner is allowed. */
function readOnlyClient(opts: { bookkeeping?: Row[] | null; tables?: string[] } = {}) {
  const queries: string[] = [];
  const client: MigrationClient = {
    async query(text) {
      queries.push(text);
      if (/to_regclass/i.test(text)) {
        return {
          rows: [{ reg: opts.bookkeeping === null ? null : "drizzle.__drizzle_migrations" }],
        };
      }
      if (/SELECT hash, created_at FROM/i.test(text)) {
        return { rows: (opts.bookkeeping ?? []).map((r) => ({ ...r })) };
      }
      if (/information_schema\.tables/i.test(text)) {
        return { rows: (opts.tables ?? []).map((table_name) => ({ table_name })) };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

const WRITES = /\b(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|TRUNCATE|GRANT)\b/i;

describe("pendingMigrations (read-only dry run)", () => {
  it("lists every migration as pending when the bookkeeping table does not exist, with tags in journal order", async () => {
    const { client } = readOnlyClient({ bookkeeping: null });
    const pending = await pendingMigrations(client, folder([A, B]));
    expect(pending.map((p) => p.tag)).toEqual(["0000_a", "0001_b"]);
    expect(pending.map((p) => p.hash)).toEqual([sha(A.sql), sha(B.sql)]);
    expect(pending.map((p) => p.folderMillis)).toEqual([A.when, B.when]);
  });

  it("excludes migrations whose hash is recorded, including the CRLF/LF forms", async () => {
    const multi = { tag: "0002_m", when: 3_000, sql: 'CREATE TABLE "m" (\n  id int\n);\n' };
    const { client } = readOnlyClient({
      bookkeeping: [
        { hash: sha(A.sql), created_at: A.when },
        { hash: sha(multi.sql.replace(/\n/g, "\r\n")), created_at: multi.when },
      ],
    });
    const pending = await pendingMigrations(client, folder([A, B, multi]));
    expect(pending.map((p) => p.tag)).toEqual(["0001_b"]);
  });

  it("is empty for a database that already holds every migration", async () => {
    const { client } = readOnlyClient({
      bookkeeping: [
        { hash: sha(A.sql), created_at: A.when },
        { hash: sha(B.sql), created_at: B.when },
      ],
    });
    expect(await pendingMigrations(client, folder([A, B]))).toEqual([]);
  });

  it("issues ONLY read queries: no DDL, no INSERT, no transaction", async () => {
    const { client, queries } = readOnlyClient({ bookkeeping: null });
    await pendingMigrations(client, folder([A, B]));
    await describePlan(client, folder([A, B]));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q, q).not.toMatch(WRITES);
  });

  it("applyMigrations with dryRun reports the count and never runs a statement", async () => {
    const { client, queries } = readOnlyClient({ bookkeeping: null });
    const count = await applyMigrations(client, folder([A, B]), { dryRun: true });
    expect(count).toBe(2);
    for (const q of queries) expect(q, q).not.toMatch(WRITES);
    expect(queries).not.toContain(A.sql);
  });

  it("derives the tables a pending migration would create, with and without IF NOT EXISTS", async () => {
    const e: Entry = {
      tag: "0000_t",
      when: 1,
      sql: 'CREATE TABLE "one" (id int);\n--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS "two" (id int);',
    };
    const { client } = readOnlyClient({ bookkeeping: null });
    const [p] = await pendingMigrations(client, folder([e]));
    expect(p!.createsTables).toEqual(["one", "two"]);
  });
});

describe("describePlan lists every file it considered", () => {
  it("marks each journal file recorded or not, in journal order, and exposes the raw recorded rows", async () => {
    const { client } = readOnlyClient({
      bookkeeping: [{ hash: sha(A.sql), created_at: A.when }],
      tables: [],
    });
    const plan = await describePlan(client, folder([A, B]));
    expect(plan.considered.map((c) => [c.tag, c.recorded])).toEqual([
      [expect.stringContaining("0000"), true],
      [expect.stringContaining("0001"), false],
    ]);
    expect(plan.recordedRows).toEqual([{ hash: sha(A.sql), createdAt: A.when }]);
    // pending is exactly the files not recorded
    expect(plan.pending.map((p) => p.tag)).toEqual(
      plan.considered.filter((c) => !c.recorded).map((c) => c.tag),
    );
  });
});

describe("describePlan classifies each pending migration", () => {
  it("a normal new migration is 'new'", async () => {
    const { client } = readOnlyClient({ bookkeeping: [], tables: [] });
    const plan = await describePlan(client, folder([A]));
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]!.classification).toBe("new");
    expect(plan.blockers).toEqual([]);
  });

  it("flags a migration whose table already exists but is not recorded (created outside the journal)", async () => {
    const { client } = readOnlyClient({ bookkeeping: [], tables: ["a"] });
    const plan = await describePlan(client, folder([A]));
    expect(plan.pending[0]!.classification).toBe("table-exists-unrecorded");
    expect(plan.pending[0]!.existingTables).toEqual(["a"]);
    expect(plan.blockers).toHaveLength(1);
  });

  it("flags a migration recorded under the same timestamp with a DIFFERENT hash (edited after apply)", async () => {
    const { client } = readOnlyClient({
      bookkeeping: [{ hash: sha("the OLD text of the file"), created_at: A.when }],
      tables: ["a"],
    });
    const plan = await describePlan(client, folder([A]));
    expect(plan.pending[0]!.classification).toBe("edited-after-apply");
    expect(plan.pending[0]!.recordedHashAtSameTime).toBe(sha("the OLD text of the file"));
    expect(plan.blockers).toHaveLength(1);
  });

  it("a recorded row at the same timestamp that matches by line-ending form is NOT pending at all", async () => {
    const multi = { tag: "0000_m", when: 9, sql: 'CREATE TABLE "m" (\n  id int\n);\n' };
    const { client } = readOnlyClient({
      bookkeeping: [{ hash: sha(multi.sql.replace(/\n/g, "\r\n")), created_at: multi.when }],
      tables: ["m"],
    });
    const plan = await describePlan(client, folder([multi]));
    expect(plan.pending).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("reports how many migrations are recorded and not on disk", async () => {
    const { client } = readOnlyClient({
      bookkeeping: [
        { hash: sha(A.sql), created_at: A.when },
        { hash: sha("a migration this checkout does not have"), created_at: 77 },
      ],
    });
    const plan = await describePlan(client, folder([A]));
    expect(plan.recordedNotOnDisk).toBe(1);
    expect(plan.blockers).toEqual([]);
  });

  it("an explained pending migration is distinguishable from a blocker", async () => {
    const { client } = readOnlyClient({
      bookkeeping: [{ hash: sha(A.sql), created_at: A.when }],
      tables: ["a"],
    });
    const plan = await describePlan(client, folder([A, B]));
    expect(plan.pending.map((p) => p.tag)).toEqual(["0001_b"]);
    expect(plan.pending[0]!.classification).toBe("new");
    expect(plan.blockers).toEqual([]);
  });
});
