// Mock route suite for API key creation and listing. Keys are held in
// process memory for the lifetime of the process — no chain, RPC, or
// database access. The full key value is only ever returned once, at
// creation; the list endpoint always returns a masked version.
import http from "node:http";
import crypto from "node:crypto";
import { URL, pathToFileURL } from "node:url";

let keys = [];
let nextSeq = 1;

export function resetState() {
  keys = [];
  nextSeq = 1;
}

function maskKey(fullKey) {
  return `${fullKey.slice(0, 8)}${"*".repeat(Math.max(fullKey.length - 12, 4))}${fullKey.slice(-4)}`;
}

export function createKey({ label } = {}) {
  const id = `key_${String(nextSeq++).padStart(4, "0")}`;
  const secret = crypto.randomBytes(24).toString("hex");
  const fullKey = `vlr_${secret}`;
  const record = {
    id,
    label: typeof label === "string" && label.trim() !== "" ? label : "unnamed",
    fullKey,
    maskedKey: maskKey(fullKey),
    createdAt: new Date().toISOString(),
  };
  keys.push(record);

  return {
    status: 201,
    body: {
      id: record.id,
      label: record.label,
      key: record.fullKey,
      createdAt: record.createdAt,
    },
  };
}

export function listKeys() {
  return {
    status: 200,
    body: {
      keys: keys.map(({ id, label, maskedKey, createdAt }) => ({
        id,
        label,
        maskedKey,
        createdAt,
      })),
    },
  };
}

export function handleRequest({ method = "GET", path = "", body = {} } = {}) {
  if (path === "/api-keys") {
    if (method === "POST") return createKey(body ?? {});
    if (method === "GET") return listKeys();
    return { status: 405, body: { error: "method_not_allowed" } };
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

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({ method: req.method, path: url.pathname, body });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4136;
  server.listen(port, () => {
    console.log(`api-key-crud suite listening on http://localhost:${port}`);
    console.log(`  POST /api-keys`);
    console.log(`  GET  /api-keys`);
  });
}
