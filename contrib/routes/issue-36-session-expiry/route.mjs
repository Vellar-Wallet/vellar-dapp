// Mock GET route returning a fixed session record with a derived expiry
// flag. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

const SESSION = {
  sessionId: "sess_7f3a9c2e1b4d",
  issuedAt: "2026-07-27T10:00:00.000Z",
  expiresAt: "2026-07-27T22:00:00.000Z",
};

function isExpired(expiresAt, now) {
  return new Date(now).getTime() >= new Date(expiresAt).getTime();
}

export function handleRequest({ query = {} } = {}) {
  const now = query.now || new Date().toISOString();

  return {
    status: 200,
    body: {
      ...SESSION,
      expired: isExpired(SESSION.expiresAt, now),
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/session-expiry") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4036;
  server.listen(port, () => {
    console.log(`session-expiry mock listening on http://localhost:${port}/session-expiry`);
  });
}
