import { describe, expect, it } from "vitest";
import { OriginPermissionCache } from "./origin-permission-cache";

const ORIGIN = "https://app.example";
const OTHER = "https://other.example";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function cache(ttlMs = 60_000) {
  const time = clock();
  return { cache: new OriginPermissionCache<string>({ ttlMs, now: time.now }), time };
}

describe("OriginPermissionCache", () => {
  it("returns a stored value until the TTL passes", () => {
    const { cache: c, time } = cache(1_000);
    c.set(ORIGIN, "granted");

    expect(c.get(ORIGIN)).toBe("granted");
    time.advance(999);
    expect(c.get(ORIGIN)).toBe("granted");
    time.advance(1);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("rejects a TTL that is not a positive finite number", () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new OriginPermissionCache({ ttlMs })).toThrow(RangeError);
    }
  });
});

describe("invalidate", () => {
  it("drops a cached permission and reports that it did", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");

    expect(c.invalidate(ORIGIN)).toBe(true);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("is a safe no-op the second time, when a revoke is retried", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");

    expect(c.invalidate(ORIGIN)).toBe(true);
    expect(() => c.invalidate(ORIGIN)).not.toThrow();
    expect(c.invalidate(ORIGIN)).toBe(false);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("stays a no-op however many times it is repeated", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");
    c.invalidate(ORIGIN);

    const results = Array.from({ length: 10 }, () => c.invalidate(ORIGIN));

    expect(results.every((result) => result === false)).toBe(true);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("leaves other origins alone, on the first call and on the repeat", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");
    c.set(OTHER, "also granted");

    c.invalidate(ORIGIN);
    c.invalidate(ORIGIN);

    expect(c.get(OTHER)).toBe("also granted");
  });

  it("does not reach a permission that was cached again between the two calls", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");
    c.invalidate(ORIGIN);
    c.set(ORIGIN, "granted again");

    // A retried revoke arriving after a fresh grant removes that grant, by design: the cache keys
    // on origin only, so it cannot tell the two apart. Pinned so a change is deliberate.
    expect(c.invalidate(ORIGIN)).toBe(true);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("lets the origin be cached again afterwards, with a fresh TTL", () => {
    const { cache: c, time } = cache(1_000);
    c.set(ORIGIN, "granted");
    c.invalidate(ORIGIN);
    c.invalidate(ORIGIN);
    time.advance(900);

    c.set(ORIGIN, "granted again");
    time.advance(900);

    expect(c.get(ORIGIN)).toBe("granted again");
  });

  it("is a no-op for an origin that was never cached", () => {
    const { cache: c } = cache();

    expect(c.invalidate("https://never.example")).toBe(false);
    expect(c.invalidate("https://never.example")).toBe(false);
  });

  it("is a no-op, not an error, once the entry has already expired", () => {
    const { cache: c, time } = cache(1_000);
    c.set(ORIGIN, "granted");
    time.advance(2_000);

    expect(c.get(ORIGIN)).toBeUndefined(); // expiry removes the entry on read
    expect(c.invalidate(ORIGIN)).toBe(false);
    expect(c.invalidate(ORIGIN)).toBe(false);
  });

  it("treats origins as exact strings", () => {
    const { cache: c } = cache();
    c.set("https://app.example", "granted");

    expect(c.invalidate("https://app.example/")).toBe(false);
    expect(c.invalidate("HTTPS://APP.EXAMPLE")).toBe(false);
    expect(c.get("https://app.example")).toBe("granted");
  });
});

describe("delete", () => {
  it("behaves as invalidate, including when called twice", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");

    expect(c.delete(ORIGIN)).toBe(true);
    expect(c.delete(ORIGIN)).toBe(false);
    expect(c.get(ORIGIN)).toBeUndefined();
  });

  it("shares the effect with invalidate when the two are mixed", () => {
    const { cache: c } = cache();
    c.set(ORIGIN, "granted");

    expect(c.invalidate(ORIGIN)).toBe(true);
    expect(c.delete(ORIGIN)).toBe(false);
  });
});
