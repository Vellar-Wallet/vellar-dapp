// Mock GET route returning a health check style payload. It reports on nothing but
// itself — no chain, database or downstream service is probed.
import http from "node:http";
import { URL } from "node:url";

const SERVICE = "vellar-mock";

// `now` and `uptimeSeconds` are injectable so tests can assert on fixed values
// instead of wall-clock time. In normal use both come from the running process.
export function handleRequest({ now = Date.now(), uptimeSeconds = process.uptime() } = {}) {
  const uptime = Math.max(0, Math.floor(uptimeSeconds));

  return {
    status: 200,
    body: {
      status: "ok",
      service: SERVICE,
      uptimeSeconds: uptime,
      startedAt: new Date(now - uptime * 1000).toISOString(),
      timestamp: new Date(now).toISOString(),
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4039;
  server.listen(port, () => {
    console.log(`health-check mock listening on http://localhost:${port}/health`);
  });
}
