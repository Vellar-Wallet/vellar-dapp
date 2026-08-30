// Mock GET route reporting whether a dApp origin holds an active permission
// grant. Reads from a fixed sample dataset — no chain or DB access.
import http from "node:http";
import { pathToFileURL } from "node:url";

const GRANTS = {
  "https://app.example.com": {
    grantId: "grant_4f1c1a20",
    scopes: ["accounts:read", "payments:sign"],
    grantedAt: "2026-05-02T10:12:00.000Z",
  },
  "https://dapp.example.org": {
    grantId: "grant_88ba90d3",
    scopes: ["accounts:read"],
    grantedAt: "2026-06-18T08:30:00.000Z",
  },
  "http://localhost:3000": {
    grantId: "grant_local_dev",
    scopes: ["accounts:read", "policies:read"],
    grantedAt: "2026-07-01T14:00:00.000Z",
  },
};

// A grant is looked up by bare origin, so `https://app.example.com/some/path`
// and `https://app.example.com` resolve to the same record.
function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

export function handleRequest({ query = {} } = {}) {
  const raw = query.origin;

  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: 400, body: { error: "origin_required" } };
  }

  const origin = normalizeOrigin(raw.trim());
  if (!origin) {
    return {
      status: 400,
      body: { error: "invalid_origin", message: `"${raw}" is not an http(s) origin URL` },
    };
  }

  const grant = GRANTS[origin];
  if (!grant) {
    // Unknown origins are not an error — they simply have no grant.
    return { status: 200, body: { origin, granted: false, scopes: [], grantedAt: null } };
  }

  return {
    status: 200,
    body: {
      origin,
      granted: true,
      grantId: grant.grantId,
      scopes: grant.scopes,
      grantedAt: grant.grantedAt,
    },
  };
}

export { GRANTS };

// pathToFileURL keeps the entrypoint check correct on Windows and with
// relative argv paths, where a raw `file://` + argv[1] concatenation never
// matches import.meta.url.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/permission-status") {
      const { status, body } = handleRequest({
        query: { origin: url.searchParams.get("origin") ?? undefined },
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4046;
  server.listen(port, () => {
    console.log(`permission-status mock listening on http://localhost:${port}/permission-status`);
  });
}
