// Mock route module simulating a session refresh flow. No chain or DB
// access; session state is kept in memory and resets on process restart.
import http from "node:http";
import crypto from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let session = {
  token: "tok_a1b2c3d4e5f6",
  issuedAt: "2026-07-27T10:00:00.000Z",
  expiresAt: "2026-07-27T22:00:00.000Z",
};

function isExpired(expiresAt, now) {
  return new Date(now).getTime() >= new Date(expiresAt).getTime();
}

export function handleCheck(query = {}) {
  const now = query.now || new Date().toISOString();
  return {
    status: 200,
    body: {
      token: session.token,
      expiresAt: session.expiresAt,
      expired: isExpired(session.expiresAt, now),
    },
  };
}

export function handleRefresh(body = {}) {
  const now = body.now || new Date().toISOString();
  const newToken = `tok_${crypto.randomBytes(6).toString("hex")}`;
  const newExpiresAt = new Date(new Date(now).getTime() + SESSION_TTL_MS).toISOString();

  session = {
    token: newToken,
    issuedAt: now,
    expiresAt: newExpiresAt,
  };

  return {
    status: 200,
    body: { token: session.token, issuedAt: session.issuedAt, expiresAt: session.expiresAt },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/session-refresh/check") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleCheck(query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/session-refresh/refresh") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          const { status, body: resp } = handleRefresh(body);
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
  const port = process.env.PORT || 4074;
  server.listen(port, () => {
    console.log(
      `session-refresh mock listening on http://localhost:${port}/session-refresh/{check,refresh}`,
    );
  });
}
