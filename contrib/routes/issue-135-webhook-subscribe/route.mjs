// Mock route accepting a webhook subscription request. In-memory only, no
// chain, RPC, or database access. State resets whenever the process
// restarts.
import http from "node:http";
import { URL } from "node:url";

let subscriptions = [];
let nextId = 1;

export function resetState() {
  subscriptions = [];
  nextId = 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

// POST /webhooks/subscribe — validate { url, events[] } and echo back a
// created record with a generated id.
export function subscribe({ body = {} } = {}) {
  const { url, events } = body;

  if (!isNonEmptyString(url)) {
    return {
      status: 400,
      body: { error: "invalid_url", message: "url is required and must be a non-empty string" },
    };
  }
  if (!isNonEmptyArray(events)) {
    return {
      status: 400,
      body: { error: "invalid_events", message: "events must be a non-empty array" },
    };
  }

  const subscription = {
    id: `sub_${String(nextId).padStart(4, "0")}`,
    url,
    events,
    createdAt: new Date().toISOString(),
  };
  nextId += 1;
  subscriptions.push(subscription);

  return { status: 201, body: subscription };
}

export function handleRequest({ method = "GET", path = "", body = {} } = {}) {
  if (path === "/webhooks/subscribe") {
    return method === "POST"
      ? subscribe({ body })
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({ method: req.method, path: url.pathname, body });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4135;
  server.listen(port, () => {
    console.log(`webhook-subscribe listening on http://localhost:${port}`);
    console.log(`  POST /webhooks/subscribe   body: { url, events[] }`);
  });
}
