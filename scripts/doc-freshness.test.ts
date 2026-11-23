import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCUMENTED_SERVICES,
  checkRoutes,
  checkVersionFloors,
  extractCodeRoutes,
  extractDocumentedRoutes,
  findBrokenCommands,
  normalizeRoutePath,
  parseDocumentedFloors,
  parseNodeEngine,
  parsePackageManager,
  parseStellarCliPin,
  parseToolchainChannel,
  runDocChecks,
  type DocumentedRoute,
  type RouteRef,
  type VersionSources,
} from "./doc-freshness";

// ── #750: version floors ──────────────────────────────────────────────────

const PREREQS = `
## Prerequisites

| Tool                     | Version                  | Used for                 |
| ------------------------ | ------------------------ | ------------------------ |
| **Node.js**              | ≥ 22                     | Runtime                  |
| **pnpm**                 | 11.x                     | Workspace                |
| **Docker**               | any recent               | Local Postgres + Redis   |
| **Rust + \`stellar\` CLI** | cargo 1.94+, stellar 26+ | Soroban policy contract  |
| **Chrome**               | any recent               | Extension dev task       |
`;

const SOURCES: VersionSources = {
  node: { major: 22, minor: 0 },
  pnpm: { major: 11, minor: 9 },
  cargo: { major: 1, minor: 94 },
  stellar: { major: 26, minor: 1 },
};

describe("parseDocumentedFloors", () => {
  it("reads the Node, pnpm, cargo and stellar floors from the prerequisites table", () => {
    expect(parseDocumentedFloors(PREREQS)).toEqual({
      node: { major: 22, minor: 0 },
      pnpm: { major: 11, minor: 0 },
      cargo: { major: 1, minor: 94 },
      stellar: { major: 26, minor: 0 },
    });
  });

  it("keeps a documented minor version (≥ 20.6)", () => {
    const floors = parseDocumentedFloors("| **Node.js** | ≥ 20.6 | Runtime |");
    expect(floors.node).toEqual({ major: 20, minor: 6 });
  });

  it("reads only the Prerequisites section, not later tables that name the same tools", () => {
    const sources = [
      "## Sources",
      "",
      "| Tool | Source |",
      "| --- | --- |",
      "| Node.js | root package.json |",
      "| pnpm | package.json |",
    ].join("\n");
    const md = `${PREREQS}\n${sources}\n`;
    expect(parseDocumentedFloors(md)).toEqual(parseDocumentedFloors(PREREQS));
  });

  it("ignores rows it does not know and tables without version rows", () => {
    expect(parseDocumentedFloors("| **Docker** | any recent | x |")).toEqual({});
    expect(parseDocumentedFloors("no table here")).toEqual({});
  });
});

describe("source-of-truth parsers", () => {
  it.each([
    [">=22", { major: 22, minor: 0 }],
    [">=20.6.0", { major: 20, minor: 6 }],
    [">= 18", { major: 18, minor: 0 }],
  ])("parseNodeEngine(%s)", (range, expected) => {
    expect(parseNodeEngine(range)).toEqual(expected);
  });

  it.each([undefined, "", "22", "^22.0.0", "latest"])("parseNodeEngine rejects %s", (range) => {
    expect(() => parseNodeEngine(range)).toThrow(/engines\.node/);
  });

  it("parsePackageManager reads pnpm's version", () => {
    expect(parsePackageManager("pnpm@11.9.0")).toEqual({ major: 11, minor: 9 });
    expect(() => parsePackageManager("yarn@4.0.0")).toThrow(/packageManager/);
    expect(() => parsePackageManager(undefined)).toThrow(/packageManager/);
  });

  it("parseToolchainChannel reads the pinned rustc channel", () => {
    const toml = `[toolchain]\nchannel = "1.94.0"\ntargets = ["wasm32v1-none"]\n`;
    expect(parseToolchainChannel(toml)).toEqual({ major: 1, minor: 94 });
    expect(() => parseToolchainChannel(`[toolchain]\nchannel = "stable"\n`)).toThrow(/channel/);
  });

  it("parseStellarCliPin reads the Dockerfile ARG", () => {
    const dockerfile = `FROM rust:1.94.0\nARG STELLAR_CLI_VERSION=26.1.0\nARG WASM_TARGET=x\n`;
    expect(parseStellarCliPin(dockerfile)).toEqual({ major: 26, minor: 1 });
    expect(() => parseStellarCliPin("FROM rust:1.94.0")).toThrow(/STELLAR_CLI_VERSION/);
  });
});

describe("checkVersionFloors", () => {
  it("passes when every documented floor matches its source of truth", () => {
    expect(checkVersionFloors(parseDocumentedFloors(PREREQS), SOURCES)).toEqual([]);
  });

  it("fails when the documented Node floor differs from engines.node", () => {
    const floors = parseDocumentedFloors(PREREQS.replace("≥ 22", "≥ 20.6"));
    expect(checkVersionFloors(floors, SOURCES)).toEqual([
      "Node.js: docs say 20.6, source of truth says 22.0",
    ]);
  });

  it("fails when the documented pnpm major differs from packageManager", () => {
    const floors = parseDocumentedFloors(PREREQS.replace("11.x", "10.x"));
    expect(checkVersionFloors(floors, SOURCES)).toEqual([
      "pnpm: docs say 10, source of truth says 11",
    ]);
  });

  it("accepts any pnpm minor when the docs only name the major", () => {
    const floors = parseDocumentedFloors(PREREQS);
    expect(checkVersionFloors(floors, { ...SOURCES, pnpm: { major: 11, minor: 0 } })).toEqual([]);
  });

  it("fails when the cargo floor differs from the pinned toolchain", () => {
    const floors = parseDocumentedFloors(PREREQS.replace("cargo 1.94+", "cargo 1.90+"));
    expect(checkVersionFloors(floors, SOURCES)).toEqual([
      "cargo: docs say 1.90, source of truth says 1.94",
    ]);
  });

  it("fails when the stellar floor differs from the pinned CLI", () => {
    const floors = parseDocumentedFloors(PREREQS.replace("stellar 26+", "stellar 25+"));
    expect(checkVersionFloors(floors, SOURCES)).toEqual([
      "stellar-cli: docs say 25, source of truth says 26",
    ]);
  });

  it("reports every disagreement and every missing floor", () => {
    const problems = checkVersionFloors({}, SOURCES);
    expect(problems).toHaveLength(4);
    expect(problems.every((p) => p.includes("documents no"))).toBe(true);
  });
});

// ── #749: API routes ──────────────────────────────────────────────────────

const API_DOC = `# API Reference

## Health

\`\`\`
GET /health  →  200
\`\`\`

## Wallet API (\`/wallet/*\` → wallet-service)

### \`POST /wallet/create\`

### \`GET /wallet/sessions?contractId=C...&network=testnet\`

## Lifecycle API (\`/lifecycle/*\` → lifecycle-service)

### \`POST /lifecycle/inspect\`

## Policy API (\`/policies/*\` → policy-service)

### \`GET /policies/:id\`

## Verification API (\`/verification/*\` → verification-service)

### \`GET /verification/:contractId/status\`
`;

const SERVER_SOURCES: Record<string, string> = {
  "wallet-service": `
    app.post("/wallet/create", async () => {});
    app.get("/wallet/sessions", async () => {});
    app.get("/wallet/session", async () => {});`,
  "lifecycle-service": `app.post("/lifecycle/inspect", async () => {});`,
  "policy-service": `app.get("/policies/:policyId", handler);`,
  "verification-service": `app.get("/verification/:id/status", async () => {});`,
};

function codeByService(overrides: Record<string, string> = {}) {
  return Object.fromEntries(
    Object.entries({ ...SERVER_SOURCES, ...overrides }).map(([service, src]) => [
      service,
      extractCodeRoutes(src),
    ]),
  );
}

describe("extractDocumentedRoutes", () => {
  const routes = extractDocumentedRoutes(API_DOC);

  it("finds every `### METHOD /path` heading", () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /wallet/create",
      "GET /wallet/sessions?contractId=C...&network=testnet",
      "POST /lifecycle/inspect",
      "GET /policies/:id",
      "GET /verification/:contractId/status",
    ]);
  });

  it("attributes each route to the service named in its section heading", () => {
    expect(routes.map((r) => r.service)).toEqual([
      "wallet-service",
      "wallet-service",
      "lifecycle-service",
      "policy-service",
      "verification-service",
    ]);
  });

  it("ignores routes shown in code blocks and records line numbers", () => {
    expect(routes.some((r) => r.path === "/health")).toBe(false);
    expect(routes[0]?.line).toBe(API_DOC.split("\n").indexOf("### `POST /wallet/create`") + 1);
  });

  it("drops the service on a section that does not name one", () => {
    const md = "## Wallet (`/wallet/*` → wallet-service)\n\n## Notes\n\n### `GET /orphan`\n";
    expect(extractDocumentedRoutes(md)).toEqual([
      { method: "GET", path: "/orphan", service: undefined, line: 5 },
    ]);
  });
});

describe("extractCodeRoutes", () => {
  it("reads app.<method>(path) registrations", () => {
    expect(
      extractCodeRoutes(`
        app.get("/a", h);
        app.post('/b/:id', h);
        app.delete(\`/c\`, h);
        app.patch( "/d", h);
        // not a route: app.use("/x")
        const note = "app.getter('/y')";`),
    ).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b/:id" },
      { method: "DELETE", path: "/c" },
      { method: "PATCH", path: "/d" },
    ]);
  });
});

describe("normalizeRoutePath", () => {
  it("strips the query string and trailing slash, and ignores param names", () => {
    expect(normalizeRoutePath("/wallet/sessions?contractId=C...&network=testnet")).toBe(
      "/wallet/sessions",
    );
    expect(normalizeRoutePath("/policies/:id/simulate/")).toBe("/policies/:param/simulate");
    expect(normalizeRoutePath("/policies/:policyId/simulate")).toBe("/policies/:param/simulate");
    expect(normalizeRoutePath("/")).toBe("/");
  });
});

describe("checkRoutes", () => {
  const documented = extractDocumentedRoutes(API_DOC);

  it("passes when every documented route is registered, across all four services", () => {
    expect(new Set(documented.map((d) => d.service))).toEqual(new Set(DOCUMENTED_SERVICES));
    expect(checkRoutes(documented, codeByService()).missing).toEqual([]);
  });

  it("matches routes whose parameter names differ between docs and code", () => {
    // docs: GET /policies/:id, code: GET /policies/:policyId
    expect(checkRoutes(documented, codeByService()).missing).toEqual([]);
  });

  it("fails when a documented route no longer exists in its service", () => {
    const result = checkRoutes(
      documented,
      codeByService({ "lifecycle-service": `app.post("/lifecycle/plan", h);` }),
    );
    expect(result.missing).toEqual([
      expect.stringContaining("POST /lifecycle/inspect is not registered in lifecycle-service"),
    ]);
  });

  it("fails when the method differs", () => {
    const result = checkRoutes(
      documented,
      codeByService({ "wallet-service": `app.get("/wallet/create", h);` }),
    );
    expect(result.missing.some((m) => m.includes("POST /wallet/create"))).toBe(true);
  });

  it("does not accept a route that is registered in a different service", () => {
    const result = checkRoutes(
      documented,
      codeByService({
        "lifecycle-service": ``,
        "policy-service": `app.post("/lifecycle/inspect", h); app.get("/policies/:id", h);`,
      }),
    );
    expect(result.missing).toEqual([expect.stringContaining("POST /lifecycle/inspect")]);
  });

  it("reports code routes that are not documented, without failing", () => {
    const result = checkRoutes(documented, codeByService());
    expect(result.missing).toEqual([]);
    expect(result.undocumented).toEqual(["wallet-service: GET /wallet/session"]);
  });

  it("fails on a documented route under no service or an unknown service", () => {
    const stray: DocumentedRoute[] = [
      { method: "GET", path: "/x", service: undefined, line: 3 },
      { method: "GET", path: "/y", service: "billing-service", line: 4 },
    ];
    const result = checkRoutes(stray, codeByService());
    expect(result.missing).toEqual([
      expect.stringContaining("/x is under no service"),
      expect.stringContaining("unknown billing-service"),
    ]);
  });

  it("treats an empty documented set as a pass with everything undocumented", () => {
    const code: Record<string, RouteRef[]> = { "wallet-service": [{ method: "GET", path: "/a" }] };
    expect(checkRoutes([], code)).toEqual({
      missing: [],
      undocumented: ["wallet-service: GET /a"],
    });
  });
});

// ── #747: runnable commands ───────────────────────────────────────────────

describe("findBrokenCommands", () => {
  const scripts = new Set(["test:e2e", "check:docs"]);
  const exists = (path: string) => path === "scripts/real.ts";

  it("flags a tsx command whose file no longer exists", () => {
    const md = "```bash\nnpx tsx contrib/load-test-submission.ts\n```";
    expect(findBrokenCommands(md, scripts, exists)).toEqual([
      expect.stringContaining("contrib/load-test-submission.ts does not exist"),
    ]);
  });

  it("flags a `pnpm <script>:<sub>` command with no matching root script", () => {
    const md = "```bash\npnpm test:load\n```";
    expect(findBrokenCommands(md, scripts, exists)).toEqual([
      expect.stringContaining('no root script "test:load"'),
    ]);
  });

  it("accepts commands that point at real files and scripts", () => {
    const md = "```bash\ntsx scripts/real.ts --flag\n$ pnpm check:docs\npnpm test:e2e\n```";
    expect(findBrokenCommands(md, scripts, exists)).toEqual([]);
  });

  it("ignores pnpm built-ins and commands outside fenced blocks", () => {
    const md = [
      "Run `pnpm test:load` or `npx tsx contrib/gone.ts` (inline, not fenced).",
      "```bash",
      "pnpm install",
      "pnpm typecheck",
      "```",
    ].join("\n");
    expect(findBrokenCommands(md, scripts, exists)).toEqual([]);
  });

  it("reports the line number of each broken command", () => {
    const md = "intro\n```bash\npnpm ok\npnpm test:load\n```";
    expect(findBrokenCommands(md, scripts, exists)[0]).toMatch(/^line 4:/);
  });
});

// ── The real repo ─────────────────────────────────────────────────────────

describe("this repository", () => {
  it("has no documentation drift (docs match code, config and toolchain pins)", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(runDocChecks(root).errors).toEqual([]);
  });
});
