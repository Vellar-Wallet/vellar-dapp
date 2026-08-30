import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: API Key Lifecycle (Issue #145)
 * Endpoints: create (with scopes), check-scope, and revoke.
 * A revoked key fails check-scope for any scope afterward.
 */

const apiKeys = new Map();

export function createApiKey({ scopes } = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { status: 400, payload: { error: "scopes_required" } };
  }

  if (!scopes.every((scope) => typeof scope === "string" && scope.trim().length > 0)) {
    return { status: 400, payload: { error: "invalid_scope" } };
  }

  const keyId = crypto.randomUUID();
  const uniqueScopes = [...new Set(scopes)];
  apiKeys.set(keyId, { keyId, scopes: uniqueScopes, revoked: false, createdAt: new Date().toISOString() });

  return { status: 201, payload: { keyId, scopes: uniqueScopes, revoked: false } };
}

export function checkScope(keyId, scope) {
  const key = apiKeys.get(keyId);
  if (!key) {
    return { status: 404, payload: { error: "key_not_found" } };
  }

  if (key.revoked) {
    return { status: 200, payload: { allowed: false, reason: "revoked" } };
  }

  const allowed = key.scopes.includes(scope);
  return { status: 200, payload: { allowed, reason: allowed ? "granted" : "scope_not_permitted" } };
}

export function revokeApiKey(keyId) {
  const key = apiKeys.get(keyId);
  if (!key) {
    return { status: 404, payload: { error: "key_not_found" } };
  }

  key.revoked = true;
  return { status: 200, payload: { keyId, revoked: true } };
}

export function handleRequest(req, res, bodyData) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && parts[0] === "api-keys" && parts.length === 1) {
    let parsed;
    try {
      parsed = JSON.parse(bodyData || "{}");
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    const { status, payload } = createApiKey(parsed);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "GET" && parts[0] === "api-keys" && parts[2] === "check-scope") {
    const scope = url.searchParams.get("scope");
    const { status, payload } = checkScope(parts[1], scope);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "POST" && parts[0] === "api-keys" && parts[2] === "revoke") {
    const { status, payload } = revokeApiKey(parts[1]);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

const PORT = process.env.PORT || 4145;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      handleRequest(req, res, body);
    });
  });

  server.listen(PORT, () => {
    console.log(`api-key-lifecycle-suite mock listening on http://localhost:${PORT}/api-keys`);
  });
}
