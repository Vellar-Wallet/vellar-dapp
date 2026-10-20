import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS, IdempotencyStore } from "./idempotency-store";

describe("IdempotencyStore (issue #260)", () => {
  it("misses on an unknown key", () => {
    const store = new IdempotencyStore();
    expect(store.lookup("key-1", "hash-a")).toEqual({ kind: "miss" });
  });

  it("hits on a repeated key with the SAME payload", () => {
    const store = new IdempotencyStore();
    const record = {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: '{"hash":"tx123"}',
      recordedAt: Date.now(),
    };
    store.record("key-1", record);

    const result = store.lookup("key-1", "hash-a");
    expect(result).toEqual({ kind: "hit", record });
  });

  it("reports a conflict on a repeated key with a DIFFERING payload", () => {
    const store = new IdempotencyStore();
    store.record("key-1", {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt: Date.now(),
    });

    const result = store.lookup("key-1", "hash-b");
    expect(result).toEqual({ kind: "conflict" });
  });

  it("never serves a hit for an expired record (treats it as a miss)", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const recordedAt = Date.now();
    store.record("key-1", {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt,
    });

    const stillFresh = store.lookup("key-1", "hash-a", recordedAt + 500);
    expect(stillFresh.kind).toBe("hit");

    const expired = store.lookup("key-1", "hash-a", recordedAt + 1001);
    expect(expired).toEqual({ kind: "miss" });
  });

  it("an expired record does not count as a conflict either, even with a different payload", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const recordedAt = Date.now();
    store.record("key-1", {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt,
    });

    // Different payload hash AND expired: miss wins, not conflict, since the
    // old record has fully aged out.
    const result = store.lookup("key-1", "hash-b", recordedAt + 1001);
    expect(result).toEqual({ kind: "miss" });
  });

  it("pruneExpired removes only expired entries and reports the count", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const now = Date.now();
    store.record("fresh", {
      payloadHash: "h",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt: now,
    });
    store.record("stale-1", {
      payloadHash: "h",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt: now - 2000,
    });
    store.record("stale-2", {
      payloadHash: "h",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt: now - 5000,
    });

    expect(store.size).toBe(3);
    const pruned = store.pruneExpired(now);
    expect(pruned).toBe(2);
    expect(store.size).toBe(1);
    expect(store.lookup("fresh", "h", now)).toMatchObject({ kind: "hit" });
    expect(store.lookup("stale-1", "h", now)).toEqual({ kind: "miss" });
  });

  it("different keys are fully independent", () => {
    const store = new IdempotencyStore();
    store.record("key-a", {
      payloadHash: "h",
      statusCode: 201,
      headers: {},
      body: "a",
      recordedAt: Date.now(),
    });
    store.record("key-b", {
      payloadHash: "h",
      statusCode: 202,
      headers: {},
      body: "b",
      recordedAt: Date.now(),
    });

    expect(
      (store.lookup("key-a", "h") as { kind: "hit"; record: { statusCode: number } }).record
        .statusCode,
    ).toBe(201);
    expect(
      (store.lookup("key-b", "h") as { kind: "hit"; record: { statusCode: number } }).record
        .statusCode,
    ).toBe(202);
  });

  describe("per-route TTL overrides (#544)", () => {
    it("retains a key that is valid under its route TTL override even after the global default TTL has elapsed", () => {
      const globalDefaultTtlMs = 5_000;
      const policyRouteTtlMs = 60_000;
      const store = new IdempotencyStore({
        ttlMs: globalDefaultTtlMs,
        routeTtlMs: {
          "/policies": policyRouteTtlMs,
        },
      });

      const recordedAt = 100_000;
      store.record("policy-deploy-key", {
        payloadHash: "hash-policy",
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: '{"policyId":"pol-1"}',
        recordedAt,
        route: "/v1/policies/deploy",
      });
      store.record("unscoped-key", {
        payloadHash: "hash-generic",
        statusCode: 200,
        headers: {},
        body: "{}",
        recordedAt,
        route: "/other/route",
      });

      // At recordedAt + 20_000ms:
      // - Global default (5_000ms) has long expired -> unscoped-key is a miss
      // - /policies override (60_000ms) is still valid -> policy-deploy-key is a hit!
      const checkTime = recordedAt + 20_000;
      expect(store.lookup("unscoped-key", "hash-generic", checkTime)).toEqual({ kind: "miss" });
      expect(store.lookup("policy-deploy-key", "hash-policy", checkTime)).toMatchObject({
        kind: "hit",
        record: { body: '{"policyId":"pol-1"}' },
      });

      // Conflict detection also remains active within the extended route TTL window
      expect(store.lookup("policy-deploy-key", "different-hash", checkTime)).toEqual({
        kind: "conflict",
      });

      // pruneExpired at checkTime removes only unscoped-key, keeping policy-deploy-key
      expect(store.pruneExpired(checkTime)).toBe(1);
      expect(store.size).toBe(1);

      // Once the route TTL (60_000ms) itself elapses, policy-deploy-key expires too
      expect(
        store.lookup("policy-deploy-key", "hash-policy", recordedAt + policyRouteTtlMs + 1),
      ).toEqual({ kind: "miss" });
    });

    it("resolves documented DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS across versioned and unversioned prefixes", () => {
      const store = new IdempotencyStore({
        ttlMs: 10_000,
        routeTtlMs: { ...DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS },
      });

      expect(store.resolveTtlMs("/policies/deploy")).toBe(
        DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS["/policies"],
      );
      expect(store.resolveTtlMs("/v1/policies/deploy")).toBe(
        DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS["/policies"],
      );
      expect(store.resolveTtlMs("/v1/wallet/connect")).toBe(
        DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS["/wallet"],
      );
      expect(store.resolveTtlMs("/unknown")).toBe(10_000);
    });
  });
});
