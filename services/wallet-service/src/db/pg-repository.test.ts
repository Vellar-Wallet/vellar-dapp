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

// Integration tests against a real Postgres. Skipped unless TEST_DATABASE_URL
// is set (CI provides a service container; locally: infra/docker compose).
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("pg repositories", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await connectDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await handle.close();
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
    it("round-trips sessions and misses cleanly on junk ids", async () => {
      const repo = createPgSessionRepository(handle.db);
      const record = {
        id: crypto.randomUUID(),
        contractId: "C1",
        network: "testnet" as const,
        createdAt: "2026-07-16T10:00:00.000Z",
        lastActiveAt: "2026-07-16T11:00:00.000Z",
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

    it("delete returns true once and false for missing ids", async () => {
      const repo = createPgSessionRepository(handle.db);
      await repo.insert({
        id: "to-revoke",
        contractId: "C1",
        network: "testnet",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
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

      const session = await app.inject({ url: `/wallet/session/${connect.json().sessionId}` });
      expect(session.statusCode).toBe(200);
      expect(session.json().contractId).toBe("CE2E");

      await app.close();
    });
  });
});
