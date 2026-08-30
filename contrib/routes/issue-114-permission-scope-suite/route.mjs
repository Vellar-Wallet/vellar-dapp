import http from "node:http";

const requests = new Map();
let nextId = 1;

function requestScopes(body) {
  const { scopes = [] } = body || {};
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { status: 400, body: { error: "scopes array required" } };
  }
  const id = `req_${nextId++}`;
  requests.set(id, { scopes, approved: [] });
  return { status: 200, body: { requestId: id, requestedScopes: scopes } };
}

function approveScopes(body) {
  const { requestId, approvedScopes = [] } = body || {};
  if (!requestId || !requests.has(requestId)) {
    return { status: 404, body: { error: "request not found" } };
  }
  const req = requests.get(requestId);
  const valid = approvedScopes.filter((s) => req.scopes.includes(s));
  req.approved = valid;
  return { status: 200, body: { requestId, approved: valid, rejected: req.scopes.filter((s) => !valid.includes(s)) } };
}

function checkScope(query) {
  const { requestId, scope } = query || {};
  if (!requestId || !scope) {
    return { status: 400, body: { error: "requestId and scope required" } };
  }
  const req = requests.get(requestId);
  if (!req) {
    return { status: 404, body: { error: "request not found" } };
  }
  return { status: 200, body: { scope, approved: req.approved.includes(scope) } };
}

export function handleRequest(method, url, body, query) {
  if (method === "POST" && url === "/request-scopes") return requestScopes(body);
  if (method === "POST" && url === "/approve-scopes") return approveScopes(body);
  if (method === "GET" && url === "/check-scope") return checkScope(query);
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
      const { status, body: resp } = handleRequest(req.method, urlObj.pathname, parsed, query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  const port = process.env.PORT || 4114;
  server.listen(port, () => {
    console.log(`permission-scope mock listening on http://localhost:${port}`);
  });
}
