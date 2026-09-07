import { describe, expect, it } from "vitest";
import { buildPermissionServer } from "./server";

describe("permission-service /health endpoint", () => {
  it("returns 200 ok when service and dependencies are healthy", async () => {
    const server = buildPermissionServer({
      dbCheck: async () => true,
    });

    const res = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      service: "permission-service",
    });
  });

  it("returns 503 unavailable when database dependency check fails", async () => {
    const server = buildPermissionServer({
      dbCheck: async () => false,
    });

    const res = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "unavailable",
      service: "permission-service",
    });
  });

  it("returns 503 unavailable when database check throws an error", async () => {
    const server = buildPermissionServer({
      dbCheck: async () => {
        throw new Error("Postgres connection lost");
      },
    });

    const res = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "unavailable",
      service: "permission-service",
    });
  });
});
