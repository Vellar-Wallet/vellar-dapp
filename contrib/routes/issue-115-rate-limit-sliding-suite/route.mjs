import http from "node:http";

const WINDOW_MS = 60_000;
const MAX_HITS = 5;

const hits = new Map();

function hit(body) {
  const { clientId = "default", time } = body || {};
  const now = typeof time === "number" ? time : Date.now();
  if (!hits.has(clientId)) hits.set(clientId, []);
  const clientHits = hits.get(clientId);
  const windowStart = now - WINDOW_MS;
  const active = clientHits.filter((t) => t > windowStart);
  if (active.length >= MAX_HITS) {
    return { status: 429, body: { clientId, allowed: false, remaining: 0, windowMs: WINDOW_MS, limit: MAX_HITS } };
  }
  active.push(now);
  hits.set(clientId, active);
  return { status: 200, body: { clientId, allowed: true, remaining: MAX_HITS - active.length, windowMs: WINDOW_MS, limit: MAX_HITS } };
}

function status(query) {
  const { clientId = "default", time } = query || {};
  const now = typeof time === "number" ? Number(time) : Date.now();
  const clientHits = hits.get(clientId) || [];
  const windowStart = now - WINDOW_MS;
  const active = clientHits.filter((t) => t > windowStart);
  return { status: 200, body: { clientId, remaining: MAX_HITS - active.length, used: active.length, windowMs: WINDOW_MS, limit: MAX_HITS } };
}

export function handleRequest(method, url, body, query) {
  if (method === "POST" && url === "/hit") return hit(body);
  if (method === "GET" && url === "/status") return status(query);
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const query = Object.fromEntries(urlObj.searchParams);
      const { status: code, body: resp } = handleRequest(req.method, urlObj.pathname, parsed, query);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  const port = process.env.PORT || 4115;
  server.listen(port, () => {
    console.log(`rate-limit-sliding mock listening on http://localhost:${port}`);
  });
}
