// Mock POST route accepting a permission grant for a dApp origin and echoing
// back a confirmation record. No chain, DB, or persistence.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ALLOWED_SCOPES = ["accounts:read", "payments:sign", "policies:read"];
const DEFAULT_SCOPES = ["accounts:read"];

// Only web origins can hold a grant — `javascript:`, `data:` and friends are
// rejected outright.
const ALLOWED_PROTOCOLS = ["http:", "https:"];

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.includes(url.protocol) || !url.hostname) return null;
  return url.origin;
}

export function handleRequest(body) {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "origin_required" } };
  }

  const { origin, scopes } = body;

  if (typeof origin === "undefined" || origin === null || origin === "") {
    return { status: 400, body: { error: "origin_required" } };
  }

  if (typeof origin !== "string") {
    return { status: 400, body: { error: "origin_must_be_string" } };
  }

  const normalizedOrigin = normalizeOrigin(origin.trim());
  if (!normalizedOrigin) {
    return {
      status: 400,
      body: {
        error: "invalid_origin",
        message: `"${origin}" is not an http(s) origin URL`,
      },
    };
  }

  let grantedScopes = DEFAULT_SCOPES;
  if (typeof scopes !== "undefined") {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return { status: 400, body: { error: "scopes_must_be_non_empty_array" } };
    }
    const unknown = scopes.filter((s) => !ALLOWED_SCOPES.includes(s));
    if (unknown.length > 0) {
      return {
        status: 400,
        body: {
          error: "invalid_scope",
          message: `Unknown scope(s): ${unknown.join(", ")}. Must be one of: ${ALLOWED_SCOPES.join(", ")}`,
        },
      };
    }
    grantedScopes = [...new Set(scopes)];
  }

  return {
    status: 201,
    body: {
      granted: true,
      grantId: `grant_${randomUUID()}`,
      origin: normalizedOrigin,
      scopes: grantedScopes,
      grantedAt: new Date().toISOString(),
    },
  };
}

export { ALLOWED_SCOPES, DEFAULT_SCOPES };

// pathToFileURL keeps the entrypoint check correct on Windows and with
// relative argv paths, where a raw `file://` + argv[1] concatenation never
// matches import.meta.url.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/permission-grant") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          const { status, body: resp } = handleRequest(body);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  // 4045 (the issue number) is on the WHATWG blocked-port list, so browsers
  // and `fetch()` refuse to talk to it — 4145 keeps the same digits and works.
  const port = process.env.PORT || 4145;
  server.listen(port, () => {
    console.log(`permission-grant mock listening on http://localhost:${port}/permission-grant`);
  });
}
