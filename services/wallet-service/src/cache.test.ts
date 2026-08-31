import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryCacheStore, NoOpCache } from "./cache";

describe("MemoryCacheStore", () => {
  let cache: MemoryCacheStore;

  beforeEach(() => {
    cache = new MemoryCacheStore(100); // 100ms TTL for testing
  });

  it("returns miss for unknown keys", async () => {
    const result = await cache.get("balance", "unknown-key");
    expect(result).toEqual({ hit: false });
  });

  it("stores and retrieves values", async () => {
    await cache.set("balance", "key1", { amount: 100 });
    const result = await cache.get("balance", "key1");
    expect(result).toEqual({ hit: true, value: { amount: 100 } });
  });

  it("separates keys by resource type", async () => {
    await cache.set("balance", "key1", "balance-value");
    await cache.set("nonce", "key1", "nonce-value");

    const balance = await cache.get("balance", "key1");
    const nonce = await cache.get("nonce", "key1");

    expect(balance.value).toBe("balance-value");
    expect(nonce.value).toBe("nonce-value");
  });

  it("expires entries after TTL", async () => {
    await cache.set("balance", "key1", "value");

    const before = await cache.get("balance", "key1");
    expect(before.hit).toBe(true);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = await cache.get("balance", "key1");
    expect(after.hit).toBe(false);
  });

  it("overwrites existing keys", async () => {
    await cache.set("balance", "key1", "value1");
    await cache.set("balance", "key1", "value2");

    const result = await cache.get("balance", "key1");
    expect(result.value).toBe("value2");
  });

  it("deletes entries", async () => {
    await cache.set("balance", "key1", "value");
    await cache.delete("balance", "key1");

    const result = await cache.get("balance", "key1");
    expect(result.hit).toBe(false);
  });

  it("clears all entries", async () => {
    await cache.set("balance", "key1", "value");
    await cache.set("nonce", "key2", "value");

    expect(cache.size()).toBe(2);

    await cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("cleans up expired entries", async () => {
    await cache.set("balance", "key1", "value1");
    await cache.set("nonce", "key2", "value2");
    expect(cache.size()).toBe(2);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const removed = await cache.cleanup();
    expect(removed).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("only cleans up expired entries, not fresh ones", async () => {
    const cache2 = new MemoryCacheStore(200); // Longer TTL
    await cache2.set("balance", "key1", "value1");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const cache1 = new MemoryCacheStore(100);
    await cache1.set("nonce", "key2", "value2");

    // key1 should be expired, key2 should not
    const removed = await cache1.cleanup();
    expect(removed).toBe(0); // cache1 has no expired entries

    // But we can clean cache2
    const removed2 = await cache2.cleanup();
    expect(removed2).toBe(1); // cache2.key1 is expired
  });

  it("handles different value types", async () => {
    await cache.set("balance", "string", "text");
    await cache.set("nonce", "number", 42);
    await cache.set("account", "object", { id: 1, name: "test" });
    await cache.set("tx-history", "array", [1, 2, 3]);

    const string = await cache.get("balance", "string");
    const number = await cache.get("nonce", "number");
    const object = await cache.get("account", "object");
    const array = await cache.get("tx-history", "array");

    expect(string.value).toBe("text");
    expect(number.value).toBe(42);
    expect(object.value).toEqual({ id: 1, name: "test" });
    expect(array.value).toEqual([1, 2, 3]);
  });
});

describe("NoOpCache", () => {
  let cache: NoOpCache;

  beforeEach(() => {
    cache = new NoOpCache();
  });

  it("always returns miss", async () => {
    const result = await cache.get("balance", "key");
    expect(result).toEqual({ hit: false });
  });

  it("set is no-op", async () => {
    await cache.set("balance", "key", "value");
    const result = await cache.get("balance", "key");
    expect(result.hit).toBe(false);
  });

  it("delete is no-op", async () => {
    await cache.delete("balance", "key");
    // Should not throw
  });
});
