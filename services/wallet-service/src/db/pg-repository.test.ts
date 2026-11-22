import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateWalletError } from "../repository";
import { buildServer } from "../server";
import type { TransactionSubmitter } from "../relayer";
import { connectDb, type DbHandle } from "./client";
import {
  createPgAuditLog,
  createPgSessionRepository,
  createPgWalletRepository,
} from "./pg-repository";
import { activityLogs, wallets, walletSessions } from "./schema";

// Integration tests against a real Postgres. Skipped LOCALLY unless
// TEST_DATABASE_URL is set (CI provides a service container; locally:
// infra/docker compose). CI sets CI_REQUIRE_DB=1 so these FAIL rather than
// silently skip if the DB service ever goes missing (RA-2).
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset — DB integration tests would silently skip.",
  );
}

describe.skipIf(!DATABASE_URL)("pg repositories", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await connectDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    // Guarded: if beforeAll's connectDb threw, handle never got assigned and a
    // bare close() would bury the real failure under a TypeError.
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.delete(activityLogs);
    await handle.db.delete(walletSessions);
    await handle.db.delete(wallets);
  });

  describe("wallet repository", () => {
    it("round-trips a record with ISO timestamps intact", async () => {
      const repo = createPgWalletRepository(handle.db);
      const record = {
        keyId: "key-1",
        contractId: "C1",
        network: "testnet" as const,
        createdAt: "2026-07-16T10:00:00.000Z",
      };
      await repo.insert(record);
      await expect(repo.findByKeyId("key-1", "testnet")).resolves.toEqual(record);
    });

    it("throws DuplicateWalletError for the same passkey on the same network", async () => {
      const repo = createPgWalletRepository(handle.db);
      const record = {
        keyId: "key-1",
        contractId: "C1",
        network: "testnet" as const,
        createdAt: new Date().toISOString(),
      };
      await repo.insert(record);
      await expect(repo.insert({ ...record, contractId: "C2" })).rejects.toBeInstanceOf(
        DuplicateWalletError,
      );
    });

    it("scopes wallets by network and misses cleanly", async () => {
      const repo = createPgWalletRepository(handle.db);
      await repo.insert({
        keyId: "key-1",
        contractId: "C1",
        network: "testnet",
        createdAt: new Date().toISOString(),
      });
      await expect(repo.findByKeyId("key-1", "mainnet")).resolves.toBeUndefined();
      await expect(repo.findByKeyId("nope", "testnet")).resolves.toBeUndefined();
      // Same passkey on another network is a separate wallet, not a duplicate.
      await expect(
        repo.insert({
          keyId: "key-1",
          contractId: "C9",
          network: "mainnet",
          createdAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("session repository", () => {
    // Far-future expiry so these round-trip/list tests aren't clock-sensitive;
    // expiry behavior itself is covered by its own test below.
    const FAR = "2099-01-01T00:00:00.000Z";

    it("round-trips sessions and misses cleanly on junk ids", async () => {
      const repo = createPgSessionRepository(handle.db);
      const record = {
        id: crypto.randomUUID(),
        contractId: "C1",
        network: "testnet" as const,
        createdAt: "2026-07-16T10:00:00.000Z",
        lastActiveAt: "2026-07-16T11:00:00.000Z",
        expiresAt: FAR,
      };
      await repo.insert(record);
      await expect(repo.find(record.id)).resolves.toEqual(record);
      await expect(repo.find("not-a-uuid-at-all")).resolves.toBeUndefined();
    });

    it("lists sessions by account most-recently-active first, scoped by network", async () => {
      const repo = createPgSessionRepository(handle.db);
      const base = {
        contractId: "C1",
        network: "testnet" as const,
        createdAt: "2026-07-16T10:00:00.000Z",
        expiresAt: FAR,
      };
      await repo.insert({ ...base, id: "older", lastActiveAt: "2026-07-16T10:00:00.000Z" });
      await repo.insert({ ...base, id: "newer", lastActiveAt: "2026-07-16T12:00:00.000Z" });
      await repo.insert({
        ...base,
        id: "other-net",
        network: "mainnet",
        lastActiveAt: "2026-07-16T13:00:00.000Z",
      });

      const listed = await repo.listByContract("C1", "testnet");
      expect(listed.map((s) => s.id)).toEqual(["newer", "older"]);
    });

    it("treats an expired session as ABSENT for find and listByContract (RA-3)", async () => {
      const repo = createPgSessionRepository(handle.db);
      const asOf = new Date("2026-08-09T00:00:00.000Z");
      const expired = {
        id: "expired-1",
        contractId: "CEXP",
        network: "testnet" as const,
        createdAt: "2026-07-01T00:00:00.000Z",
        lastActiveAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z", // before asOf
      };
      await repo.insert(expired);
      // Expired == missing: no response distinguishes "expired" from "never existed".
      await expect(repo.find("expired-1", asOf)).resolves.toBeUndefined();
      await expect(repo.listByContract("CEXP", "testnet", asOf)).resolves.toEqual([]);
    });

    it("touch slides a live session forward but no-ops on an expired one (RA-3)", async () => {
      const repo = createPgSessionRepository(handle.db);
      const asOf = new Date("2026-08-09T00:00:00.000Z");
      const newExpiry = new Date("2026-08-16T00:00:00.000Z");
      await repo.insert({
        id: "live-1",
        contractId: "CT",
        network: "testnet",
        createdAt: "2026-08-08T00:00:00.000Z",
        lastActiveAt: "2026-08-08T00:00:00.000Z",
        expiresAt: "2026-08-15T00:00:00.000Z", // after asOf → live
      });
      await expect(repo.touch("live-1", asOf, newExpiry)).resolves.toBe(true);
      const after = await repo.find("live-1", asOf);
      expect(after?.expiresAt).toBe(newExpiry.toISOString());
      expect(after?.lastActiveAt).toBe(asOf.toISOString());

      // An already-expired session cannot extend its own life.
      await repo.insert({
        id: "dead-1",
        contractId: "CT",
        network: "testnet",
        createdAt: "2026-07-01T00:00:00.000Z",
        lastActiveAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z", // before asOf → expired
      });
      await expect(repo.touch("dead-1", asOf, newExpiry)).resolves.toBe(false);
      await expect(repo.touch("never", asOf, newExpiry)).resolves.toBe(false);
    });

    it("delete returns true once and false for missing ids", async () => {
      const repo = createPgSessionRepository(handle.db);
      await repo.insert({
        id: "to-revoke",
        contractId: "C1",
        network: "testnet",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        expiresAt: FAR,
      });
      await expect(repo.delete("to-revoke")).resolves.toBe(true);
      await expect(repo.delete("to-revoke")).resolves.toBe(false);
      await expect(repo.delete("never-existed")).resolves.toBe(false);
    });
  });

  describe("audit log", () => {
    it("records and lists events in order", async () => {
      const audit = createPgAuditLog(handle.db);
      await audit.record("wallet.created", { contractId: "C1" });
      await audit.record("tx.submitted", { txHash: "h" });
      const events = await audit.list();
      expect(events.map((e) => e.type)).toEqual(["wallet.created", "tx.submitted"]);
      expect(events[0]?.data).toEqual({ contractId: "C1" });
    });

    // issue #256: real-database coverage for listPage. server.test.ts's
    // in-memory suite already proves the pagination algorithm itself is
    // correct; this proves the actual SQL keyset query (ORDER BY / WHERE
    // against a real column, not an in-memory array) agrees with it.
    describe("listPage (issue #256)", () => {
      it("scopes to actor+type and paginates with no skip or duplicate", async () => {
        const audit = createPgAuditLog(handle.db);
        // A small real delay between inserts, not just back-to-back awaits:
        // activity_logs.id is a random UUID (not insertion-ordered), so two
        // events landing in the SAME microsecond would tiebreak by an
        // arbitrary-but-stable UUID order, not insertion order — a real,
        // valid keyset order, just not one this test can predict. Spacing
        // inserts out removes that ambiguity so the order assertion below is
        // deterministic, matching how distinct requests actually arrive.
        for (let i = 0; i < 5; i++) {
          await audit.record("tx.submitted", { txHash: `h${i}` }, "C1");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // Noise that must never appear in C1's paginated tx.submitted history.
        await audit.record("wallet.created", { contractId: "C1" }, "C1");
        await audit.record("tx.submitted", { txHash: "other" }, "C2");

        const seen: string[] = [];
        let after: string | undefined;
        for (let i = 0; i < 10; i++) {
          const page = await audit.listPage({ type: "tx.submitted", actor: "C1", limit: 2, after });
          expect(page.events.length).toBeLessThanOrEqual(2);
          seen.push(...page.events.map((e) => (e.data as { txHash: string }).txHash));
          if (!page.hasMore) {
            expect(page.nextCursor).toBeUndefined();
            break;
          }
          expect(page.nextCursor).toBeDefined();
          after = page.nextCursor;
        }

        expect(seen).toEqual(["h4", "h3", "h2", "h1", "h0"]);
      });

      it("tiebreaks by id when two rows share the exact same `at` (deterministic, not timing-dependent)", async () => {
        // record() always stamps `at: new Date()`, so it cannot itself
        // produce two rows with an IDENTICAL timestamp deterministically.
        // Insert directly to force the tie this test exists to check.
        const at = new Date("2024-06-01T00:00:00.000Z");
        await handle.db.insert(activityLogs).values([
          { id: "id-a", type: "tx.submitted", at, data: { txHash: "a" }, actor: "C1" },
          { id: "id-b", type: "tx.submitted", at, data: { txHash: "b" }, actor: "C1" },
        ]);
        const audit = createPgAuditLog(handle.db);

        const seen: string[] = [];
        let after: string | undefined;
        for (let i = 0; i < 10; i++) {
          const page = await audit.listPage({ type: "tx.submitted", actor: "C1", limit: 1, after });
          expect(page.events).toHaveLength(1);
          seen.push((page.events[0]!.data as { txHash: string }).txHash);
          if (!page.hasMore) break;
          after = page.nextCursor;
        }
        // Order for the tie is "id-b" then "id-a" (id DESC), but the exact
        // order matters less than: BOTH appear, and each EXACTLY once, even
        // though limit=1 forces the cursor to land exactly between them.
        expect(seen.sort()).toEqual(["a", "b"]);
      });

      it("rejects a malformed cursor rather than returning an arbitrary page", async () => {
        const audit = createPgAuditLog(handle.db);
        await audit.record("tx.submitted", { txHash: "h" }, "C1");
        await expect(
          audit.listPage({ actor: "C1", limit: 10, after: "not-a-real-cursor" }),
        ).rejects.toThrow();
      });

      it("returns an empty page (not an error) when nothing matches", async () => {
        const audit = createPgAuditLog(handle.db);
        const page = await audit.listPage({ actor: "no-such-actor", limit: 10 });
        expect(page).toEqual({ events: [], hasMore: false, nextCursor: undefined });
      });
    });
  });

  describe("full route flow on Postgres", () => {
    it("create -> connect -> session fetch works end to end", async () => {
      const submitter: TransactionSubmitter = {
        submit: vi.fn().mockResolvedValue({ hash: "pg-hash" }),
      };
      const app = buildServer({
        submitter,
        wallets: createPgWalletRepository(handle.db),
        sessions: createPgSessionRepository(handle.db),
        audit: createPgAuditLog(handle.db),
      });

      const create = await app.inject({
        method: "POST",
        url: "/wallet/create",
        payload: { keyId: "key-e2e", contractId: "CE2E", network: "testnet", signedTx: "xdr" },
      });
      expect(create.statusCode).toBe(201);

      const connect = await app.inject({
        method: "POST",
        url: "/wallet/connect",
        payload: { keyId: "key-e2e", network: "testnet" },
      });
      expect(connect.statusCode).toBe(200);
      expect(connect.json().contractId).toBe("CE2E");

      const session = await app.inject({
        url: "/wallet/session",
        headers: { authorization: `Bearer ${connect.json().sessionId}` },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().contractId).toBe("CE2E");

      await app.close();
    });
  });

  describe("read during in-progress schema migration (#789)", () => {
    it("behaves predictably when a concurrent migration locks reads", async () => {
      const repo = createPgWalletRepository(handle.db);
      await repo.insert({
        keyId: "key-migr",
        contractId: "C-MIGR",
        network: "testnet",
        createdAt: "2026-07-16T10:00:00.000Z",
      });

      const admin = await handle.pool.connect();
      try {
        await admin.query("BEGIN");
        await admin.query("LOCK TABLE wallets IN ACCESS EXCLUSIVE MODE");

        const read = repo.findByKeyId("key-migr", "testnet");
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("read blocked by migration lock")), 150),
        );

        await expect(Promise.race([read, timeout])).rejects.toThrow(/read blocked by migration lock/);

        await admin.query("ROLLBACK");
        await expect(repo.findByKeyId("key-migr", "testnet")).resolves.toEqual({
          keyId: "key-migr",
          contractId: "C-MIGR",
          network: "testnet",
          createdAt: "2026-07-16T10:00:00.000Z",
        });
      } finally {
        try {
          await admin.query("ROLLBACK");
        } catch {}
        admin.release();
      }
    });
  });
});
