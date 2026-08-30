import { describe, it, expect } from "vitest";
import {
  createMemoryAuditLog,
  createNoOpAuditLog,
  initializeAuditLog,
  type AuditLog,
} from "./audit";
import { generateRedactionSalt } from "./audit-redaction";

describe("audit.ts", () => {
  describe("createMemoryAuditLog", () => {
    it("records events and returns them via list()", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      await audit.record("test.event1", { foo: "bar" });
      await audit.record("test.event2", { baz: "qux" });

      const events = await audit.list();

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("test.event1");
      expect(events[1].type).toBe("test.event2");
    });

    it("automatically redacts events before storage", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      // Record an event with PII
      const accountId = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      await audit.record("lifecycle.cleanup_planned", {
        plan: {
          accountId,
          destination: "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
          blockers: [],
          estimatedTransactions: 1,
          mergeReady: true,
        },
      });

      const events = await audit.list();
      const event = events[0];

      // Stored event should be redacted
      const plan = (event.data as Record<string, unknown>).plan as Record<string, unknown>;
      expect(plan.accountRef).toBeDefined();
      expect(plan.accountId).toBeUndefined();

      // Raw account ID should NOT be in the stored event
      const eventStr = JSON.stringify(event);
      expect(eventStr).not.toContain(accountId);
    });

    it("includes timestamp when recording events", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      const beforeTime = new Date().toISOString();
      await audit.record("test.event", {});
      const afterTime = new Date().toISOString();

      const events = await audit.list();
      const event = events[0];

      expect(event.at).toBeDefined();
      expect(event.at >= beforeTime).toBe(true);
      expect(event.at <= afterTime).toBe(true);
    });

    it("preserves insertion order", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      for (let i = 0; i < 5; i++) {
        await audit.record(`test.event_${i}`, { index: i });
      }

      const events = await audit.list();
      expect(events.map((e) => e.type)).toEqual([
        "test.event_0",
        "test.event_1",
        "test.event_2",
        "test.event_3",
        "test.event_4",
      ]);
    });
  });

  describe("createNoOpAuditLog", () => {
    it("does not record any events", async () => {
      const audit = createNoOpAuditLog();

      await audit.record("test.event1", { foo: "bar" });
      await audit.record("test.event2", { baz: "qux" });

      const events = await audit.list();
      expect(events).toHaveLength(0);
    });

    it("returns empty list on list()", async () => {
      const audit = createNoOpAuditLog();

      await audit.record("test.event", { data: "value" });

      const events = await audit.list();
      expect(events).toEqual([]);
    });
  });

  describe("initializeAuditLog", () => {
    it("returns salt and audit log for 'memory' implementation", () => {
      const [salt, audit] = initializeAuditLog("memory");

      expect(salt).toBeDefined();
      expect(typeof salt).toBe("string");
      expect(salt.length).toBe(64); // 256 bits in hex

      expect(audit).toBeDefined();
      expect(typeof audit.record).toBe("function");
      expect(typeof audit.list).toBe("function");
    });

    it("returns salt and no-op audit log for 'noop' implementation", () => {
      const [salt, audit] = initializeAuditLog("noop");

      expect(salt).toBeDefined();
      expect(typeof salt).toBe("string");

      // Should be no-op behavior
      (audit as any).record("test", {});
      expect((audit as any).list()).resolves.toEqual([]);
    });

    it("defaults to 'memory' implementation", () => {
      const [salt, audit] = initializeAuditLog();

      expect(salt).toBeDefined();

      // Should record events
      (audit as any).record("test", {});
      expect((audit as any).list()).resolves.toHaveLength(1);
    });

    it("generates a new salt each time", () => {
      const [salt1] = initializeAuditLog();
      const [salt2] = initializeAuditLog();

      expect(salt1).not.toBe(salt2);
    });

    it("audit log created with generated salt applies consistent redaction", async () => {
      const [, audit] = initializeAuditLog("memory");

      const accountId = "GXXXXX...";
      const destination = "GYYYY...";

      // Record same plan twice
      await audit.record("lifecycle.cleanup_planned", {
        plan: {
          accountId,
          destination,
          blockers: [],
          estimatedTransactions: 1,
          mergeReady: true,
        },
      });

      await audit.record("lifecycle.cleanup_planned", {
        plan: {
          accountId,
          destination,
          blockers: [],
          estimatedTransactions: 1,
          mergeReady: true,
        },
      });

      const events = await audit.list();
      const event1Plan = (events[0].data as Record<string, unknown>).plan as Record<string, unknown>;
      const event2Plan = (events[1].data as Record<string, unknown>).plan as Record<string, unknown>;

      // Same account → same hash
      expect(event1Plan.accountRef).toBe(event2Plan.accountRef);
      expect(event1Plan.destinationRef).toBe(event2Plan.destinationRef);
    });
  });

  describe("Audit log usage patterns", () => {
    it("can record complex nested data structures", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      const complexData = {
        plan: {
          accountId: "GXXX...",
          destination: "GYYYY...",
          blockers: [
            { type: "balance", description: "Has balance" },
            { type: "trustline", description: "Has trustline" },
          ],
          estimatedTransactions: 3,
          mergeReady: false,
        },
        metadata: {
          nested: {
            deeply: {
              value: 42,
            },
          },
        },
      };

      await audit.record("test.complex", complexData);

      const events = await audit.list();
      expect(events).toHaveLength(1);
      expect(events[0].data).toBeDefined();
    });

    it("handles rapid sequential records", async () => {
      const salt = generateRedactionSalt();
      const audit = createMemoryAuditLog(salt);

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(audit.record(`test.event_${i}`, { index: i }));
      }
      await Promise.all(promises);

      const events = await audit.list();
      expect(events).toHaveLength(100);
    });
  });
});
