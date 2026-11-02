import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  DeploymentMarkerError,
  ensureDeploymentMarker,
  tryConnectDb,
  type DeployEnv,
} from "@vellar/service-kit";
import { connectDb as connectWalletDb } from "./client";

// The database tier marker against REAL Postgres: production and staging each refuse a
// database that belongs to the other tier, in both directions, without writing to it.
// Skipped locally unless TEST_DATABASE_URL is set; CI sets CI_REQUIRE_DB=1 so the suite
// fails instead of silently skipping (the RA-2 lesson).
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset: the database tier marker would silently skip.",
  );
}

const NO_FLAG = {} as NodeJS.ProcessEnv;
const INIT = { INIT_DEPLOY_MARKER: "1" } as NodeJS.ProcessEnv;

describe.skipIf(!DATABASE_URL)("ensureDeploymentMarker against a real database", () => {
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

  /** A brand-new empty database; `readOnly` makes the SERVER reject any write on it. */
  async function freshDatabase(readOnly = false): Promise<{ name: string; url: string }> {
    const name = `vellar_marker_${Math.random().toString(36).slice(2, 10)}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
    const u = new URL(DATABASE_URL as string);
    u.pathname = `/${name}`;
    return { name, url: u.toString() };
  }

  async function run<T>(url: string, fn: (c: pg.PoolClient) => Promise<T>, readOnly = false) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 1,
      ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
      await pool.end();
    }
  }

  const ensure = (url: string, env: DeployEnv, flags = NO_FLAG, readOnly = false) =>
    run(url, (c) => ensureDeploymentMarker(c, env, flags), readOnly);

  const marker = (url: string) =>
    run(url, async (c) => {
      const reg = await c.query(`SELECT to_regclass('public.deployment_marker') AS reg`);
      if (reg.rows[0].reg == null) return "no-table";
      const { rows } = await c.query(`SELECT deploy_env FROM public.deployment_marker`);
      return rows.map((r) => r.deploy_env);
    });

  describe("production", () => {
    it("adopts an unmarked database as 'production' (first boot after this change)", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      expect(await marker(url)).toEqual(["production"]);
    });

    it("adopts an existing, non-empty unmarked database (the live deployment's case) and keeps its data", async () => {
      const { url } = await freshDatabase();
      await run(url, (c) =>
        c.query(`CREATE TABLE wallets (key_id text); INSERT INTO wallets VALUES ('a')`),
      );
      await ensure(url, "production");
      expect(await marker(url)).toEqual(["production"]);
      expect(
        await run(
          url,
          async (c) => (await c.query(`SELECT count(*)::int n FROM wallets`)).rows[0].n,
        ),
      ).toBe(1);
    });

    it("is idempotent: a second boot changes nothing", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      const first = await run(
        url,
        async (c) => (await c.query(`SELECT set_at FROM deployment_marker`)).rows[0].set_at,
      );
      await ensure(url, "production");
      const second = await run(
        url,
        async (c) => (await c.query(`SELECT set_at FROM deployment_marker`)).rows[0].set_at,
      );
      expect(second).toEqual(first);
    });

    it("REFUSES a database marked 'staging'", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "staging", INIT);
      await expect(ensure(url, "production")).rejects.toThrow(DeploymentMarkerError);
      await expect(ensure(url, "production")).rejects.toThrow(
        /DEPLOY_ENV=production.*marked 'staging'/,
      );
    });

    it("never overwrites an existing marker: production does not flip a staging database", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "staging", INIT);
      await ensure(url, "production").catch(() => {});
      expect(await marker(url)).toEqual(["staging"]);
    });
  });

  describe("staging", () => {
    it("REFUSES a database marked 'production', and writes nothing (works on a read-only connection)", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      await expect(ensure(url, "staging", INIT, true)).rejects.toThrow(/marked 'production'/);
      expect(await marker(url)).toEqual(["production"]);
    });

    it("REFUSES an unmarked database without the init flag, and creates nothing in it", async () => {
      const { url } = await freshDatabase();
      await expect(ensure(url, "staging")).rejects.toThrow(/no deployment marker/);
      expect(await marker(url)).toBe("no-table");
    });

    it("REFUSES an unmarked database when the flag is falsy (0, false, blank)", async () => {
      const { url } = await freshDatabase();
      for (const v of ["0", "false", ""]) {
        await expect(
          ensure(url, "staging", { INIT_DEPLOY_MARKER: v } as NodeJS.ProcessEnv),
        ).rejects.toThrow(/no deployment marker/);
      }
    });

    it("claims a FRESH database as 'staging' with INIT_DEPLOY_MARKER=1, then boots without the flag", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "staging", INIT);
      expect(await marker(url)).toEqual(["staging"]);
      await expect(ensure(url, "staging")).resolves.toBeUndefined();
    });

    it("REFUSES to claim a non-empty unmarked database even with the flag (e.g. production before it was marked), writing nothing", async () => {
      const { url } = await freshDatabase();
      await run(url, (c) => c.query(`CREATE TABLE wallets (key_id text)`));
      await expect(ensure(url, "staging", INIT, true)).rejects.toThrow(
        /not empty \(1 existing tables\)/,
      );
      await expect(ensure(url, "staging", INIT)).rejects.toThrow(/not empty/);
      expect(await marker(url)).toBe("no-table");
    });

    it("counts tables in other schemas too: drizzle's bookkeeping alone makes a database non-fresh", async () => {
      const { url } = await freshDatabase();
      await run(url, (c) =>
        c.query(`CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id int)`),
      );
      await expect(ensure(url, "staging", INIT)).rejects.toThrow(/not empty/);
    });
  });

  describe("development", () => {
    it("never creates a marker, and allows an unmarked or staging database", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "development");
      expect(await marker(url)).toBe("no-table");
      const staging = await freshDatabase();
      await ensure(staging.url, "staging", INIT);
      await expect(ensure(staging.url, "development")).resolves.toBeUndefined();
    });

    it("REFUSES a database marked production, even on a read-only connection (writes nothing)", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      await expect(ensure(url, "development", NO_FLAG, true)).rejects.toThrow(
        /development.*marked 'production'/,
      );
      expect(await marker(url)).toEqual(["production"]);
    });
  });

  describe("concurrency", () => {
    // Every real caller holds the shared migration advisory lock (see connectDb): concurrent
    // CREATE TABLE IF NOT EXISTS otherwise aborts with 23505 on pg_type. Race the way the
    // services do.
    const LOCK = 0x56454c41;
    const ensureLocked = (url: string, env: DeployEnv, flags = NO_FLAG) =>
      run(url, async (c) => {
        await c.query("SELECT pg_advisory_lock($1)", [LOCK]);
        try {
          await ensureDeploymentMarker(c, env, flags);
        } finally {
          await c.query("SELECT pg_advisory_unlock($1)", [LOCK]);
        }
      });

    it("production and staging racing for one fresh database: exactly one wins, the other refuses", async () => {
      for (let round = 0; round < 5; round++) {
        const { url } = await freshDatabase();
        const settled = await Promise.allSettled([
          ensureLocked(url, "production"),
          ensureLocked(url, "staging", INIT),
        ]);
        const rows = (await marker(url)) as string[];
        expect(rows).toHaveLength(1);
        const winner = rows[0];
        const fulfilled = settled.filter((s) => s.status === "fulfilled").length;
        expect(fulfilled).toBe(1);
        const rejected = settled.find((s) => s.status === "rejected") as
          PromiseRejectedResult | undefined;
        expect(rejected?.reason).toBeInstanceOf(DeploymentMarkerError);
        expect(winner === "production" || winner === "staging").toBe(true);
      }
    });

    it("several production boots racing for one unmarked database all succeed with a single row", async () => {
      const { url } = await freshDatabase();
      await Promise.all(Array.from({ length: 6 }, () => ensureLocked(url, "production")));
      expect(await marker(url)).toEqual(["production"]);
    });
  });

  describe("the one-row guarantee is enforced by the table itself", () => {
    it("a second row, or a tier other than production/staging, is rejected by the database", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      await expect(
        run(url, (c) => c.query(`INSERT INTO deployment_marker (deploy_env) VALUES ('staging')`)),
      ).rejects.toThrow();
      await expect(
        run(url, (c) =>
          c.query(
            `INSERT INTO deployment_marker (singleton, deploy_env) VALUES (false, 'staging')`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        run(url, (c) => c.query(`UPDATE deployment_marker SET deploy_env = 'qa'`)),
      ).rejects.toThrow();
    });
  });

  describe("wired into connectDb", () => {
    const withDeployEnv = async <T>(value: string, fn: () => Promise<T>): Promise<T> => {
      const prev = { d: process.env.DEPLOY_ENV, i: process.env.INIT_DEPLOY_MARKER };
      process.env.DEPLOY_ENV = value;
      delete process.env.INIT_DEPLOY_MARKER;
      try {
        return await fn();
      } finally {
        if (prev.d === undefined) delete process.env.DEPLOY_ENV;
        else process.env.DEPLOY_ENV = prev.d;
        if (prev.i !== undefined) process.env.INIT_DEPLOY_MARKER = prev.i;
      }
    };

    it("a staging service refuses a production-marked database BEFORE migrating it", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      await withDeployEnv("staging", async () => {
        await expect(connectWalletDb(url)).rejects.toThrow(DeploymentMarkerError);
      });
      const tables = await run(url, async (c) =>
        (
          await c.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
          )
        ).rows.map((r) => r.table_name),
      );
      expect(tables).toEqual(["deployment_marker"]); // no wallet tables were created
    });

    it("a production service refuses a staging-marked database BEFORE migrating it", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "staging", INIT);
      await withDeployEnv("production", async () => {
        await expect(connectWalletDb(url)).rejects.toThrow(DeploymentMarkerError);
      });
    });

    it("a production service marks and migrates an unmarked database", async () => {
      const { url } = await freshDatabase();
      await withDeployEnv("production", async () => {
        const handle = await connectWalletDb(url);
        await handle.close();
      });
      expect(await marker(url)).toEqual(["production"]);
    });

    it("tryConnectDb does NOT turn a marker mismatch into an in-memory fallback", async () => {
      const { url } = await freshDatabase();
      await ensure(url, "production");
      await withDeployEnv("staging", async () => {
        await expect(
          tryConnectDb(() => connectWalletDb(url), { databaseUrl: url, log: { warn: () => {} } }),
        ).rejects.toThrow(DeploymentMarkerError);
      });
    });
  });
});
