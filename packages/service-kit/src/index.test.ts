import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portFromEnv, redactDbUrl, registerHealth, tryConnectDb } from "./index";

describe("registerHealth", () => {
  it("responds with ok and the service name", async () => {
    const app = Fastify();
    registerHealth(app, "test-service");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "test-service" });
    await app.close();
  });
});

describe("portFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fallback when unset or empty", () => {
    vi.stubEnv("TEST_PORT", "");
    expect(portFromEnv("TEST_PORT", 4001)).toBe(4001);
    expect(portFromEnv("TEST_PORT_MISSING", 4002)).toBe(4002);
  });

  it("parses a valid port", () => {
    vi.stubEnv("TEST_PORT", "8080");
    expect(portFromEnv("TEST_PORT", 4001)).toBe(8080);
  });

  it.each([["abc"], ["-1"], ["70000"], ["80.5"]])("rejects invalid value %s", (value) => {
    vi.stubEnv("TEST_PORT", value);
    expect(() => portFromEnv("TEST_PORT", 4001)).toThrow(/valid port/);
  });
});

describe("tryConnectDb", () => {
  const databaseUrl = "postgres://vela:vela@localhost:5433/vela";

  it("returns the handle on a successful connect", async () => {
    const handle = { db: {}, close: async () => {} };
    const warn = vi.fn();
    const result = await tryConnectDb(async () => handle, { databaseUrl, log: { warn } });
    expect(result).toBe(handle);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to undefined and warns (no throw) when connect fails", async () => {
    const warn = vi.fn();
    const result = await tryConnectDb(
      async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
      },
      { databaseUrl, log: { warn } },
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0] as string;
    // Actionable: names the fallback, the failure, and how to fix it.
    expect(message).toMatch(/in-memory/i);
    expect(message).toMatch(/ECONNREFUSED/);
    expect(message).toMatch(/docker compose .* up -d/);
    // Credentials must never appear in the log.
    expect(message).not.toContain("vela:vela");
  });
});

describe("redactDbUrl", () => {
  it("masks username and password", () => {
    expect(redactDbUrl("postgres://user:secret@localhost:5433/vela")).toBe(
      "postgres://***:***@localhost:5433/vela",
    );
  });

  it("returns a safe placeholder for an unparseable url", () => {
    expect(redactDbUrl("not a url")).toBe("the configured database");
  });
});
