import { describe, expect, it } from "vitest";
import { resolvePersistencePolicy } from "./persistence";

describe("resolvePersistencePolicy (M6 fail-closed boot)", () => {
  it("dev without DATABASE_URL: allows in-memory (convenience)", () => {
    const r = resolvePersistencePolicy({ databaseUrl: undefined, nodeEnv: "development" });
    expect(r).toEqual({ action: "allow-inmemory" });
  });

  it("production without DATABASE_URL: refuses to boot (no silent stateless prod)", () => {
    const r = resolvePersistencePolicy({ databaseUrl: undefined, nodeEnv: "production" });
    expect(r.action).toBe("fail");
    if (r.action === "fail") expect(r.reason).toMatch(/DATABASE_URL/);
  });

  it("production WITH DATABASE_URL but unreachable: refuses to boot (fail-closed, not degrade)", () => {
    const r = resolvePersistencePolicy({
      databaseUrl: "postgres://x",
      nodeEnv: "production",
      connected: false,
    });
    expect(r.action).toBe("fail");
    if (r.action === "fail") expect(r.reason).toMatch(/unreachable|could not connect/i);
  });

  it("production WITH DATABASE_URL and connected: proceeds on Postgres", () => {
    const r = resolvePersistencePolicy({
      databaseUrl: "postgres://x",
      nodeEnv: "production",
      connected: true,
    });
    expect(r).toEqual({ action: "use-postgres" });
  });

  it("ALLOW_INMEMORY=1 overrides the production guard (explicit operator opt-in)", () => {
    const r = resolvePersistencePolicy({
      databaseUrl: undefined,
      nodeEnv: "production",
      allowInmemory: true,
    });
    expect(r).toEqual({ action: "allow-inmemory" });
  });

  it("dev WITH DATABASE_URL unreachable: degrades to in-memory (unchanged dev DX)", () => {
    const r = resolvePersistencePolicy({
      databaseUrl: "postgres://x",
      nodeEnv: "development",
      connected: false,
    });
    expect(r).toEqual({ action: "allow-inmemory" });
  });
});
