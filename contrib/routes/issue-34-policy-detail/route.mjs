// Mock GET route returning a single sample policy record by id. No chain or
// DB access.
import http from "node:http";

const POLICIES = {
  pol_1001: {
    id: "pol_1001",
    type: "spending-limit",
    status: "active",
    limit: "500.0000000",
    window: "daily",
  },
  pol_1002: {
    id: "pol_1002",
    type: "spending-limit",
    status: "paused",
    limit: "2000.0000000",
    window: "monthly",
  },
  pol_1003: {
    id: "pol_1003",
    type: "allowlist",
    status: "active",
    limit: null,
    window: null,
  },
};

export function handleRequest({ params = {} } = {}) {
  const { id } = params;
  const policy = id ? POLICIES[id] : undefined;

  if (!policy) {
    return {
      status: 404,
      body: { error: "not_found", message: `No policy found for id "${id ?? ""}"` },
    };
  }

  return { status: 200, body: policy };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/policies\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const { status, body } = handleRequest({ params: { id: decodeURIComponent(match[1]) } });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4034;
  server.listen(port, () => {
    console.log(`policy-detail mock listening on http://localhost:${port}/policies/:id`);
  });
}
