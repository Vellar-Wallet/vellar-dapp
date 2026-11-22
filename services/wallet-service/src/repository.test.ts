import { describe, expect, it } from "vitest";
import {
  createMemoryAuditLog,
  decodeAuditCursor,
  encodeAuditCursor,
  paginateAuditEvents,
  type AuditEvent,
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

  it("carries the wallet a page was issued for, so a replay can be rejected (#762)", () => {
    const cursor = encodeAuditCursor("2024-01-01T00:00:01.000Z", "abc-123", "CWALLETA");
    expect(decodeAuditCursor(cursor)).toEqual({
      at: "2024-01-01T00:00:01.000Z",
      id: "abc-123",
      actor: "CWALLETA",
    });
  });

  it("decodeAuditCursor throws (not silently returns garbage) on a malformed cursor", () => {
    expect(() => decodeAuditCursor("not-a-real-cursor")).toThrow();
  });

  it("decodeAuditCursor still reads a legacy unbound cursor", () => {
    const legacy = Buffer.from("2024-01-01T00:00:01.000Z:abc-123", "utf8").toString("base64url");
    expect(decodeAuditCursor(legacy)).toEqual({
      at: "2024-01-01T00:00:01.000Z",
      id: "abc-123",
    });
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
