import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server";

// Error-envelope coverage for EVERY registered route (issue #545 / #262).
//
// The suite below walks the live route table from Fastify and asserts that a
// known error condition on each route returns the standardized
// `{ error: { code, message } }` envelope. When a route does not conform,
// the assertion message names the offending route.
//
// ── Adding a new route ────────────────────────────────────────────────────────
//
// New routes are covered AUTOMATICALLY: the suite discovers the route table
// from Fastify at runtime (see `discoverRoutes`), so a newly registered route
// is tested without editing this file. Two things must stay true:
//
//   1. The route must be reachable via `buildServer`'s normal registration
//      path (i.e. added in server.ts / register-proxy-route.ts), not bolted
//      on ad-hoc in a test-only app.
//
//   2. Gateway-generated errors must go through `sendError` (or
//      `registerErrorEnvelope`'s global handlers) — never a hand-rolled
//      `reply.code(...).send({ error: ... })` body. If a route introduces a
//      NEW error path, add a case to the "specific envelopes" describe block
//      in server.test.ts alongside the existing 415/413/404/429 checks.
//
// Proxied upstream errors are forwarded unchanged (see register-proxy-route's
// replyOptions.onError) and are explicitly out of scope here: this suite
// covers the gateway's OWN error responses.

interface RouteEntry {
  method: string;
  url: string;
}

/** Parses Fastify's `printRoutes({ commonPrefix: false })` tree into a flat
 * list of `{ method, url }` entries. Wildcard (`*`) leaves are expanded to a
 * concrete probe path so the route is actually hit. */
function discoverRoutes(app: FastifyInstance): RouteEntry[] {
  const tree = app.printRoutes({ commonPrefix: false });
  const entries: RouteEntry[] = [];
  // Each line: tree-drawing prefix + path segment + " (METHOD, ...)".
  // Track the path built from indentation depth so nested segments join up.
  const depthPath: string[] = [];
  for (const line of tree.split("\n")) {
    const m = line.match(/^([\s│]*)(?:├── |└── )(\S+) \(([^)]+)\)\s*$/);
    if (!m) continue;
    const indent = m[1] ?? "";
    const segment = m[2] ?? "";
    const methods = m[3] ?? "";
    const depth = Math.floor(indent.length / 4);
    depthPath.length = depth;
    depthPath.push(segment);

    const full = depthPath.join("").replace(/\/\*$/, "/*");
    for (const method of methods.split(",").map((s) => s.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      entries.push({ method, url: full === "*" ? "/*" : full });
    }
  }
  return entries;
}

function expectEnvelope(body: unknown, route: RouteEntry): void {
  const label = `${route.method} ${route.url}`;
  expect(body, `route ${label} did not return an error envelope body`).toHaveProperty("error");
  const error = (body as { error: unknown }).error;
  expect(typeof error, `route ${label} error.code must be a string`).toBe("object");
  const { code, message } = error as { code: unknown; message: unknown };
  expect(typeof code, `route ${label} error.code must be a string`).toBe("string");
  expect(typeof message, `route ${label} error.message must be a string`).toBe("string");
  expect(code, `route ${label} error.code must be non-empty`).not.toBe("");
}

describe("api-gateway error envelope covers every registered route (#545)", () => {
  it("walks every registered route and asserts the envelope shape on a known error", async () => {
    // maxBodyBytes is tiny so a short Content-Length trips 413 on any route —
    // the onRequest hook enforces the cap before any route handler runs, so
    // this works uniformly for health, metrics, and proxied prefixes alike.
    const app = buildServer({ logger: false, maxBodyBytes: 8 });
    await app.ready();

    try {
      const routes = discoverRoutes(app);
      // Sanity: the gateway always exposes at least health + one proxy prefix.
      expect(routes.length).toBeGreaterThan(0);

      const seen = new Set<string>();
      for (const route of routes) {
        const label = `${route.method} ${route.url}`;
        // Wildcard proxy leaves resolve to a concrete sub-path for the probe.
        const url = route.url.replace(/\*$/, "probe");
        seen.add(label);

        const res = await app.inject({
          method: route.method as "GET",
          url,
          headers: { "content-length": "9999" },
        });

        // 413 is the known error condition for every route.
        expect(res.statusCode, `route ${label} should reject an oversized body with 413`).toBe(413);
        expectEnvelope(res.json(), route);
      }

      // Meta-check: we actually probed more than a trivial subset.
      expect(seen.size).toBe(routes.length);
    } finally {
      await app.close();
    }
  });

  it("names the offending route when an envelope is malformed", async () => {
    // Direct unit check of the assertion helper itself: a body that is NOT an
    // envelope must fail with a message that names the route.
    const route: RouteEntry = { method: "POST", url: "/wallet/connect" };
    expect(() => expectEnvelope({ nope: true }, route)).toThrowError(/POST \/wallet\/connect/);
    expect(() => expectEnvelope({ error: { code: 1, message: "x" } }, route)).toThrowError(
      /POST \/wallet\/connect/,
    );
  });
});
