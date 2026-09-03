// Mock route suite simulating a periodic sweep that marks expired signers
// removed. State lives in memory for the lifetime of the process — no
// chain, RPC, or database access.
import http from "node:http";
import { URL, pathToFileURL } from "node:url";

// Seed signers. A null expiresAt means the signer never expires.
const SEED_SIGNERS = [
  {
    id: "signer_admin",
    label: "Primary admin key",
    expiresAt: null,
  },
  {
    id: "signer_session_a",
    label: "Session key A",
    expiresAt: "2026-07-27T12:00:00.000Z",
  },
  {
    id: "signer_session_b",
    label: "Session key B",
    expiresAt: "2026-07-27T18:00:00.000Z",
  },
  {
    id: "signer_device",
    label: "Device key",
    expiresAt: "2026-07-28T09:00:00.000Z",
  },
  {
    id: "signer_recovery",
    label: "Recovery key",
    expiresAt: "2026-08-04T00:00:00.000Z",
  },
];

let signers = seed();
let sweepCount = 0;

function seed() {
  return SEED_SIGNERS.map((signer) => ({
    ...signer,
    status: "active",
    removedAt: null,
  }));
}

// Resets in-memory state so tests can run sweeps from a known baseline.
export function resetState() {
  signers = seed();
  sweepCount = 0;
}

function parseNow(raw) {
  if (raw === undefined || raw === "") return Date.now();
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function isExpired(signer, nowMs) {
  if (signer.expiresAt === null) return false;
  return new Date(signer.expiresAt).getTime() <= nowMs;
}

function invalidNow() {
  return {
    status: 400,
    body: {
      error: "invalid_now",
      message: "now must be an ISO 8601 timestamp",
    },
  };
}

export function listSigners({ query = {} } = {}) {
  const nowMs = parseNow(query.now);
  if (nowMs === null) return invalidNow();

  const view = signers.map((signer) => ({
    ...signer,
    // Expired but not yet swept — what the next run would pick up.
    sweepPending: signer.status === "active" && isExpired(signer, nowMs),
  }));

  return {
    status: 200,
    body: {
      now: new Date(nowMs).toISOString(),
      signers: view,
      activeCount: view.filter((signer) => signer.status === "active").length,
      removedCount: view.filter((signer) => signer.status === "removed").length,
      sweepPendingCount: view.filter((signer) => signer.sweepPending).length,
    },
  };
}

export function runSweep({ query = {}, body = {} } = {}) {
  const raw = body?.now ?? query.now;
  const nowMs = parseNow(raw);
  if (nowMs === null) return invalidNow();

  const now = new Date(nowMs).toISOString();
  const removed = [];
  for (const signer of signers) {
    if (signer.status !== "active" || !isExpired(signer, nowMs)) continue;
    signer.status = "removed";
    signer.removedAt = now;
    removed.push(signer.id);
  }
  sweepCount += 1;

  return {
    status: 200,
    body: {
      now,
      sweepRun: sweepCount,
      removedCount: removed.length,
      removedSignerIds: removed,
      remainingActive: signers.filter((signer) => signer.status === "active")
        .length,
    },
  };
}

export function handleRequest({
  method = "GET",
  path = "",
  query = {},
  body = {},
} = {}) {
  if (path === "/signer-sweep/list-signers") {
    return method === "GET"
      ? listSigners({ query })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/signer-sweep/run-sweep") {
    return method === "POST"
      ? runSweep({ query, body })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

// pathToFileURL keeps this check correct on Windows paths; argv[1] is
// undefined when the module is imported rather than executed.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body,
          });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4120;
  server.listen(port, () => {
    console.log(`signer-sweep suite listening on http://localhost:${port}`);
    console.log(`  GET  /signer-sweep/list-signers?now=2026-07-28T00:00:00.000Z`);
    console.log(`  POST /signer-sweep/run-sweep  body: {"now":"..."}`);
  });
}
