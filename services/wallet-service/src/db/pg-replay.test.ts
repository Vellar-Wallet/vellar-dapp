import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendBudget } from "@vellar/service-kit";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { createMemoryWalletRepository } from "../repository";
import type { ReplayKey } from "../replay";
import type { TransactionSubmitter } from "../relayer";
import { buildServer } from "../server";
import { buildInvokeTx, KNOWN_WALLET, OTHER_CONTRACT, PASSPHRASE } from "../test-fixtures";
import { connectDb, type DbHandle } from "./client";
import { createPgReplayGuard } from "./pg-replay";
import { submissionReplay } from "./schema";

// Replay protection against a REAL Postgres (approved design 1A). The atomic,
// all-or-nothing reservation and its concurrency guarantee can only be verified
// against the database that enforces them: a mock would make the concurrency
// test decorative. Skipped LOCALLY unless TEST_DATABASE_URL is set; CI sets
// CI_REQUIRE_DB=1 so the suite FAILS rather than silently skips (the RA-2
// lesson, and note: concurrency uses INDEPENDENT pools; Promise.all over one
// pool never actually raced).
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset: the replay concurrency guarantee would silently skip.",
  );
}

const key = (nonce: string, expiration = 1000, address = KNOWN_WALLET): ReplayKey => ({
  address,
  nonce,
  signatureExpirationLedger: expiration,
});

describe.skipIf(!DATABASE_URL)("createPgReplayGuard (atomic all-or-nothing reservation)", () => {
  let handle: DbHandle;
  const extra: DbHandle[] = [];

  beforeAll(async () => {
    handle = await connectDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await Promise.all(extra.map((h) => h.close()));
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.delete(submissionReplay);
  });

  async function independentGuard(network: "testnet" | "mainnet" = "testnet") {
    const h = await connectDb(DATABASE_URL as string);
    extra.push(h);
    return { guard: createPgReplayGuard(h.db, network), handle: h };
  }

  const count = async () => (await handle.db.select().from(submissionReplay)).length;

  it("reserves a fresh set, then refuses the same set", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    expect(await guard.reserve([key("1"), key("2")])).toEqual({ ok: true });
    expect(await guard.reserve([key("1"), key("2")])).toEqual({ ok: false, reason: "replay" });
    expect(await count()).toBe(2);
  });

  it("is ALL-OR-NOTHING: a set sharing one reserved key leaves NONE of its other keys behind", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    await guard.reserve([key("A")]);

    expect(await guard.reserve([key("B"), key("C"), key("A")])).toEqual({
      ok: false,
      reason: "replay",
    });

    expect(await count()).toBe(1); // only A; B and C were rolled back
    expect(await guard.reserve([key("B"), key("C")])).toEqual({ ok: true });
  });

  it("an empty key set reserves nothing and succeeds", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    expect(await guard.reserve([])).toEqual({ ok: true });
    expect(await count()).toBe(0);
  });

  it("keeps an int64 nonce exact, including values beyond 2^53 and negatives", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    const big = "9223372036854775807";
    expect(await guard.reserve([key(big), key("-9223372036854775808")])).toEqual({ ok: true });
    expect(await guard.reserve([key(big)])).toEqual({ ok: false, reason: "replay" });
    // A nearby value that a float round-trip would collide with must NOT collide.
    expect(await guard.reserve([key("9223372036854775806")])).toEqual({ ok: true });
  });

  it("the same (address, nonce) on the other network is a different reservation", async () => {
    const testnet = createPgReplayGuard(handle.db, "testnet");
    const mainnet = createPgReplayGuard(handle.db, "mainnet");
    expect(await testnet.reserve([key("1")])).toEqual({ ok: true });
    expect(await mainnet.reserve([key("1")])).toEqual({ ok: true });
    expect(await testnet.reserve([key("1")])).toEqual({ ok: false, reason: "replay" });
  });

  it("the same nonce under a different address is a different reservation", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    expect(await guard.reserve([key("1", 1000, KNOWN_WALLET)])).toEqual({ ok: true });
    expect(await guard.reserve([key("1", 1000, OTHER_CONTRACT)])).toEqual({ ok: true });
  });

  it("release frees exactly the given keys", async () => {
    const guard = createPgReplayGuard(handle.db, "testnet");
    await guard.reserve([key("1"), key("2")]);

    await guard.release([key("1")]);

    expect(await guard.reserve([key("1")])).toEqual({ ok: true });
    expect(await guard.reserve([key("2")])).toEqual({ ok: false, reason: "replay" });
  });

  it("release only touches this guard's network", async () => {
    const testnet = createPgReplayGuard(handle.db, "testnet");
    const mainnet = createPgReplayGuard(handle.db, "mainnet");
    await testnet.reserve([key("1")]);
    await mainnet.reserve([key("1")]);

    await testnet.release([key("1")]);

    expect(await mainnet.reserve([key("1")])).toEqual({ ok: false, reason: "replay" });
  });

  it("purgeExpired deletes strictly-below rows for this network only", async () => {
    const testnet = createPgReplayGuard(handle.db, "testnet");
    const mainnet = createPgReplayGuard(handle.db, "mainnet");
    await testnet.reserve([key("old", 99), key("edge", 100), key("live", 101)]);
    await mainnet.reserve([key("old", 99)]);

    await testnet.purgeExpired(100);

    expect(await testnet.reserve([key("old", 99)])).toEqual({ ok: true }); // purged
    expect(await testnet.reserve([key("edge", 100)])).toEqual({ ok: false, reason: "replay" });
    expect(await testnet.reserve([key("live", 101)])).toEqual({ ok: false, reason: "replay" });
    expect(await mainnet.reserve([key("old", 99)])).toEqual({ ok: false, reason: "replay" });
  });

  it("THROWS (never reports success) when the database is unreachable", async () => {
    const dead = await connectDb(DATABASE_URL as string);
    const guard = createPgReplayGuard(dead.db, "testnet");
    await dead.close();
    await expect(guard.reserve([key("1")])).rejects.toBeDefined();
  });

  describe("concurrency on independent connections", () => {
    it("identical concurrent reservations: exactly one wins", async () => {
      const guards = await Promise.all(Array.from({ length: 8 }, () => independentGuard()));

      const results = await Promise.all(
        guards.map(({ guard }) => guard.reserve([key("race-1"), key("race-2")])),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(7);
      expect(await count()).toBe(2);
    });

    it("overlapping sets in OPPOSITE orders cannot deadlock and never both succeed", async () => {
      // Even guards take [X, Y], odd guards take [Y, X]. Without a canonical
      // insert order this is the classic AB/BA deadlock. The window inside one
      // statement is tiny, so repeat over many rounds with fresh keys to make a
      // missing ordering actually surface (Postgres aborts one side with 40P01).
      const guards = await Promise.all(Array.from({ length: 6 }, () => independentGuard()));
      const ROUNDS = 60;

      for (let round = 0; round < ROUNDS; round += 1) {
        const x = key(`X${round}`);
        const y = key(`Y${round}`);
        const results = await Promise.all(
          guards.map(({ guard }, i) => guard.reserve(i % 2 === 0 ? [x, y] : [y, x])),
        );
        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1);
      }

      expect(await count()).toBe(ROUNDS * 2); // each round's winner holds exactly two keys
    });

    it("inserts keys in canonical (address, nonce) order whatever order the caller passes", async () => {
      // The AB/BA race above is a microsecond window inside one statement and
      // cannot be provoked reliably, so the invariant that prevents it is pinned
      // directly: capture the INSERT parameters and check the row order.
      const pool = new pg.Pool({ connectionString: DATABASE_URL as string });
      const inserts: unknown[][] = [];
      const db = drizzle(pool, {
        logger: {
          logQuery(query, params) {
            if (/insert into "submission_replay"/i.test(query)) inserts.push(params);
          },
        },
      });
      try {
        const guard = createPgReplayGuard(db, "testnet");

        await guard.reserve([key("30"), key("10"), key("20")]);
        await guard.reserve([key("03", 1000, OTHER_CONTRACT), key("02", 1000, KNOWN_WALLET)]);

        const rowsOf = (params: unknown[]) => {
          const rows: Array<{ address: string; nonce: string }> = [];
          for (let i = 0; i < params.length; i += 4) {
            rows.push({ address: String(params[i + 1]), nonce: String(params[i + 2]) });
          }
          return rows;
        };
        expect(rowsOf(inserts[0]!).map((r) => r.nonce)).toEqual(["10", "20", "30"]);
        const second = rowsOf(inserts[1]!);
        const sorted = [...second].sort((a, b) =>
          a.address === b.address ? (a.nonce < b.nonce ? -1 : 1) : a.address < b.address ? -1 : 1,
        );
        expect(second).toEqual(sorted);
      } finally {
        await pool.end();
      }
    });

    it("a partial overlap loses WITHOUT leaving its fresh key reserved", async () => {
      const [a, b] = await Promise.all([independentGuard(), independentGuard()]);

      const [ra, rb] = await Promise.all([
        a.guard.reserve([key("S1"), key("S2")]),
        b.guard.reserve([key("S2"), key("S3")]),
      ]);

      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      const rows = await handle.db.select().from(submissionReplay);
      // Winner holds exactly its two keys; the loser's fresh key is not stranded.
      expect(rows).toHaveLength(2);
      const loserFresh = ra.ok ? "S3" : "S1";
      expect(rows.map((r) => r.nonce)).not.toContain(loserFresh);
    });
  });

  describe("through the real route: the budget is consumed once", () => {
    let app: FastifyInstance | undefined;

    it("concurrent copies of one signed tx on independent servers spend once and send once", async () => {
      const wallets = createMemoryWalletRepository();
      await wallets.insert({
        keyId: "k",
        contractId: KNOWN_WALLET,
        network: "testnet",
        createdAt: new Date().toISOString(),
      });
      const tryConsume = vi.fn(async () => ({ ok: true as const }));
      const budget = { tryConsume } as unknown as SpendBudget;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const submitter: TransactionSubmitter = {
        submit: vi.fn(async () => {
          await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 100n });
          await gate;
          return { hash: "h" };
        }),
      };
      // Two servers, two pools: the replica case the database must arbitrate.
      const servers = await Promise.all(
        [0, 1].map(async () => {
          const { guard } = await independentGuard();
          return buildServer({
            submitter,
            wallets,
            networkPassphrase: PASSPHRASE,
            replayGuard: guard,
            getLatestLedger: async () => 1,
          });
        }),
      );
      app = servers[0];
      const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "4242", expiration: 5 }]);

      const requests = Array.from({ length: 8 }, (_, i) =>
        servers[i % 2]!.inject({
          method: "POST",
          url: "/wallet/submit",
          payload: { signedXdr: signed, network: "testnet" },
        }),
      );
      await vi.waitFor(() => expect(submitter.submit).toHaveBeenCalledTimes(1));
      open();
      const results = await Promise.all(requests);

      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(7);
      expect(tryConsume).toHaveBeenCalledTimes(1);
      await Promise.all(servers.map((s) => s.close()));
      app = undefined;
    });
  });

  it("is exercised against the table the migration created", async () => {
    const rows = await handle.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'submission_replay' order by column_name`,
    );
    expect(rows.rows.map((r) => (r as { column_name: string }).column_name)).toEqual([
      "address",
      "expiration_ledger",
      "network",
      "nonce",
      "reserved_at",
    ]);
  });
});
