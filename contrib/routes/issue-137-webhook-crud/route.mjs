// Mock route suite for webhook subscription CRUD: create, list, delete.
// Subscriptions are held in process memory for the lifetime of the
// process — no chain, RPC, or database access.
import http from "node:http";
import { URL, pathToFileURL } from "node:url";

let subscriptions = [];
let nextSeq = 1;

export function resetState() {
  subscriptions = [];
  nextSeq = 1;
}

export function createSubscription(body) {
  if (!body || typeof body.url !== "string" || body.url.trim() === "") {
    return { status: 400, body: { error: "url_required" } };
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return { status: 400, body: { error: "events_required" } };
  }

  const record = {
    id: `sub_${String(nextSeq++).padStart(4, "0")}`,
    url: body.url,
    events: [...body.events],
    createdAt: new Date().toISOString(),
  };
  subscriptions.push(record);

  return { status: 201, body: record };
}

export function listSubscriptions() {
  return { status: 200, body: { subscriptions: [...subscriptions] } };
}

export function deleteSubscription(id) {
  const index = subscriptions.findIndex((sub) => sub.id === id);
  if (index === -1) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `No webhook subscription found for id "${id ?? ""}"`,
      },
    };
  }
  const [removed] = subscriptions.splice(index, 1);
  return { status: 200, body: { deleted: true, id: removed.id } };
}

export function handleRequest({ method = "GET", path = "", body = {} } = {}) {
  if (path === "/webhook-subscriptions") {
    if (method === "POST") return createSubscription(body ?? {});
    if (method === "GET") return listSubscriptions();
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  const match = path.match(/^\/webhook-subscriptions\/([^/?]+)$/);
  if (match) {
    if (method === "DELETE") return deleteSubscription(decodeURIComponent(match[1]));
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
  const port = process.env.PORT || 4137;
  server.listen(port, () => {
    console.log(`webhook-crud suite listening on http://localhost:${port}`);
    console.log(`  POST   /webhook-subscriptions`);
    console.log(`  GET    /webhook-subscriptions`);
    console.log(`  DELETE /webhook-subscriptions/:id`);
  });
}
