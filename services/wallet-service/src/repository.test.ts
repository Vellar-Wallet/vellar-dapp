import { describe, expect, it } from "vitest";
import {
  createMemoryAuditLog,
  createMemorySessionRepository,
  createMemoryWalletRepository,
  decodeAuditCursor,
  DuplicateWalletError,
  encodeAuditCursor,
  paginateAuditEvents,
  type AuditEvent,
  type WalletRecord,
} from "./repository";

// Direct unit coverage for the keyset pagination logic behind
// AuditLog.listPage (issue #256), independent of the route-level tests in
// server.test.ts, which never construct two events sharing the exact same
// `at` timestamp (sequential audit.record calls in the in-memory store
// always get a fresh Date.now()). A tied `at` is exactly the case a
// tiebreaker exists for, so it needs its own deterministic test rather than
// relying on real-clock timing to (maybe) produce a collision.
describe("paginateAuditEvents (issue #256 keyset pagination)", () => {
  function event(id: string, at: string, actor?: string): AuditEvent {
    return { id, type: "tx.submitted", at, data: { txHash: `hash-${id}` }, actor };
  }

  it("orders newest-first by (at, id) and tiebreaks a shared `at` by id descending", () => {
    // Input order is ASCENDING id within the tied `at` group ("2" before
    // "3"), the opposite of the expected DESCENDING output order. Array.sort
    // is stable, so if the tiebreaker comparator were a no-op (e.g. `return
    // 0` for a tie), this input order would sort through unchanged and the
    // assertion below would catch it, unlike an input already in the
    // expected output order, which a broken tiebreaker could pass by
    // accident.
    const events: AuditEvent[] = [
      event("1", "2024-01-01T00:00:00.000Z"),
      event("2", "2024-01-01T00:00:01.000Z"), // tied `at` with id "3"
      event("3", "2024-01-01T00:00:01.000Z"),
    ];
    const page = paginateAuditEvents(events, { limit: 10 });
    expect(page.events.map((e) => e.id)).toEqual(["3", "2", "1"]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("paginates through a tied-`at` group with no skip or duplicate across pages", () => {
    // Ascending id within the tied `at` group ("2" before "3" before "4"),
    // the opposite of the expected descending output order (see the
    // preceding test for why this matters for a stable sort).
    const events: AuditEvent[] = [
      event("5", "2024-01-01T00:00:00.000Z"),
      event("2", "2024-01-01T00:00:01.000Z"), // tied with "3" and "4"
      event("3", "2024-01-01T00:00:01.000Z"), // tied with "2" and "4"
      event("4", "2024-01-01T00:00:01.000Z"),
      event("1", "2024-01-01T00:00:02.000Z"),
    ];

    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = paginateAuditEvents(events, { limit: 2, after });
      expect(page.events.length).toBeLessThanOrEqual(2);
      seen.push(...page.events.map((e) => e.id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.nextCursor).toBeDefined();
      after = page.nextCursor;
    }

    expect(seen).toEqual(["1", "4", "3", "2", "5"]);
  });

  it("filters by type and actor before paginating", () => {
    const events: AuditEvent[] = [
      event("1", "2024-01-01T00:00:00.000Z", "CA"),
      { ...event("2", "2024-01-01T00:00:01.000Z", "CA"), type: "wallet.connected" },
      event("3", "2024-01-01T00:00:02.000Z", "CB"),
    ];
    const page = paginateAuditEvents(events, { type: "tx.submitted", actor: "CA", limit: 10 });
    expect(page.events.map((e) => e.id)).toEqual(["1"]);
  });

  it("encodeAuditCursor/decodeAuditCursor round-trip exactly", () => {
    const cursor = encodeAuditCursor("2024-01-01T00:00:01.000Z", "abc-123");
    expect(decodeAuditCursor(cursor)).toEqual({ at: "2024-01-01T00:00:01.000Z", id: "abc-123" });
  });

  it("decodeAuditCursor throws (not silently returns garbage) on a malformed cursor", () => {
    expect(() => decodeAuditCursor("not-a-real-cursor")).toThrow();
  });
});

describe("createMemoryAuditLog.listPage (issue #256)", () => {
  it("assigns each recorded event a distinct, order-preserving id", async () => {
    const audit = createMemoryAuditLog();
    await audit.record("tx.submitted", { n: 1 }, "CA");
    await audit.record("tx.submitted", { n: 2 }, "CA");
    const page = await audit.listPage({ actor: "CA", limit: 10 });
    expect(page.events).toHaveLength(2);
    expect(page.events[0]!.data).toEqual({ n: 2 }); // newest first
    expect(page.events[1]!.data).toEqual({ n: 1 });
    expect(page.events[0]!.id).not.toBe(page.events[1]!.id);
  });
});

describe("concurrent wallet & session repository writes (issue #602)", () => {
  it("deterministically resolves first-write-wins and rejects the second concurrent insert with DuplicateWalletError", async () => {
    const repo = createMemoryWalletRepository();
    const recordA: WalletRecord = {
      keyId: "cred-concurrent-1",
      contractId: "C_CONTRACT_A",
      network: "testnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const recordB: WalletRecord = {
      keyId: "cred-concurrent-1",
      contractId: "C_CONTRACT_B",
      network: "testnet",
      createdAt: "2026-01-01T00:00:05.000Z",
    };

    const [resA, resB] = await Promise.allSettled([repo.insert(recordA), repo.insert(recordB)]);

    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("rejected");
    if (resB.status === "rejected") {
      expect(resB.reason).toBeInstanceOf(DuplicateWalletError);
    }

    const stored = await repo.findByKeyId("cred-concurrent-1", "testnet");
    expect(stored).toEqual({
      keyId: "cred-concurrent-1",
      contractId: "C_CONTRACT_A",
      network: "testnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await repo.existsByContractId("C_CONTRACT_A", "testnet")).toBe(true);
    expect(await repo.existsByContractId("C_CONTRACT_B", "testnet")).toBe(false);
  });

  it("serializes two concurrent updates to the same wallet record (FIFO last-write-wins, no half-updated record)", async () => {
    const repo = createMemoryWalletRepository();
    await repo.insert({
      keyId: "cred-concurrent-update",
      contractId: "C_INITIAL",
      network: "testnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const writeA = repo.update("cred-concurrent-update", "testnet", async (current) => {
      // Yield across microtasks so writeB is in-flight concurrently
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ...current,
        contractId: "C_FROM_WRITE_A",
        createdAt: "2026-01-01T00:01:00.000Z",
      };
    });

    const writeB = repo.update("cred-concurrent-update", "testnet", async (current) => {
      // Because updates are serialized per key, writeB observes writeA's committed state
      expect(current.contractId).toBe("C_FROM_WRITE_A");
      return {
        ...current,
        contractId: "C_FROM_WRITE_B",
        createdAt: "2026-01-01T00:02:00.000Z",
      };
    });

    const [afterA, afterB] = await Promise.all([writeA, writeB]);
    expect(afterA.contractId).toBe("C_FROM_WRITE_A");
    expect(afterB.contractId).toBe("C_FROM_WRITE_B");

    const finalRecord = await repo.findByKeyId("cred-concurrent-update", "testnet");
    expect(finalRecord).toEqual({
      keyId: "cred-concurrent-update",
      contractId: "C_FROM_WRITE_B",
      network: "testnet",
      createdAt: "2026-01-01T00:02:00.000Z",
    });
  });

  it("protects against a read-modify-write cycle racing a pure write without producing a torn/corrupted record", async () => {
    const repo = createMemoryWalletRepository();
    const initial: WalletRecord = {
      keyId: "cred-rmw",
      contractId: "C_V0",
      network: "testnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await repo.insert(initial);

    // Mutating the original caller object after insert must never corrupt the stored record
    initial.contractId = "C_CORRUPTED_BY_CALLER";

    const readModifyWrite = (async () => {
      const snapshot = await repo.findByKeyId("cred-rmw", "testnet");
      expect(snapshot).toBeDefined();
      // Attempt in-place mutation on the read snapshot while a concurrent update runs
      snapshot!.contractId = "C_UNSAFE_IN_PLACE_MUTATION";
      return repo.update("cred-rmw", "testnet", async (current) => ({
        contractId: `${current.contractId}_RMW`,
      }));
    })();

    const pureWrite = repo.update("cred-rmw", "testnet", () => ({
      contractId: "C_PURE_WRITE",
      createdAt: "2026-01-01T00:05:00.000Z",
    }));

    await Promise.all([readModifyWrite, pureWrite]);

    const finalRecord = await repo.findByKeyId("cred-rmw", "testnet");
    expect(finalRecord).toBeDefined();
    expect(finalRecord!.contractId).not.toContain("CORRUPTED");
    expect(finalRecord!.contractId).not.toContain("UNSAFE");
    // Serialized execution: pureWrite was queued first, then readModifyWrite appended _RMW to it
    expect(finalRecord).toEqual({
      keyId: "cred-rmw",
      contractId: "C_PURE_WRITE_RMW",
      network: "testnet",
      createdAt: "2026-01-01T00:05:00.000Z",
    });
  });

  it("isolates concurrent SessionRepository touch and insert writes from mutating read snapshots in place", async () => {
    const sessions = createMemorySessionRepository();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T01:00:00.000Z");
    const exp0 = new Date("2026-01-08T00:00:00.000Z");
    const exp1 = new Date("2026-01-08T01:00:00.000Z");

    await sessions.insert({
      id: "sess-1",
      contractId: "C_WALLET",
      network: "testnet",
      createdAt: t0.toISOString(),
      lastActiveAt: t0.toISOString(),
      expiresAt: exp0.toISOString(),
    });

    const snapshotBefore = await sessions.find("sess-1", t0);
    expect(snapshotBefore).toBeDefined();

    await Promise.all([
      sessions.touch("sess-1", t1, exp1),
      (async () => {
        // Concurrent reader mutating its local object must not corrupt the stored session
        snapshotBefore!.contractId = "C_TAMPERED";
      })(),
    ]);

    // Previously read snapshot was not mutated by touch's timestamp update
    expect(snapshotBefore!.lastActiveAt).toBe(t0.toISOString());

    const storedAfter = await sessions.find("sess-1", t1);
    expect(storedAfter).toEqual({
      id: "sess-1",
      contractId: "C_WALLET",
      network: "testnet",
      createdAt: t0.toISOString(),
      lastActiveAt: t1.toISOString(),
      expiresAt: exp1.toISOString(),
    });
  });
});

