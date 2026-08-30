// Mock DELETE route revoking a device session by id. No chain or DB access — the
// sample dataset is read-only and is never mutated, so the handler is pure and
// repeated calls for the same id return the same payload.
import http from "node:http";

const SESSIONS = {
  ses_a1b2c3: {
    id: "ses_a1b2c3",
    device: "iPhone 15 Pro",
    platform: "ios",
    lastSeen: "2026-07-27T09:14:00.000Z",
  },
  ses_d4e5f6: {
    id: "ses_d4e5f6",
    device: "Pixel 8",
    platform: "android",
    lastSeen: "2026-07-26T18:02:00.000Z",
  },
  ses_g7h8i9: {
    id: "ses_g7h8i9",
    device: "MacBook Pro",
    platform: "web",
    lastSeen: "2026-07-28T07:45:00.000Z",
  },
  ses_j1k2l3: {
    id: "ses_j1k2l3",
    device: "Chrome Extension",
    platform: "extension",
    lastSeen: "2026-07-25T11:30:00.000Z",
  },
};

export function handleRequest({ params = {} } = {}) {
  const { id } = params;
  // Object.hasOwn keeps inherited keys such as "constructor" from resolving to a
  // truthy value and being mistaken for a real session.
  const isKnown = typeof id === "string" && id !== "" && Object.hasOwn(SESSIONS, id);
  const session = isKnown ? SESSIONS[id] : undefined;

  if (!session) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `No device session found for id "${id ?? ""}"`,
      },
    };
  }

  return {
    status: 200,
    body: {
      revoked: true,
      id: session.id,
      device: session.device,
      platform: session.platform,
      revokedAt: new Date().toISOString(),
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/device-sessions\/([^/?]+)$/);
    if (req.method === "DELETE" && match) {
      const { status, body } = handleRequest({ params: { id: decodeURIComponent(match[1]) } });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4038;
  server.listen(port, () => {
    console.log(`device-revoke mock listening on http://localhost:${port}/device-sessions/:id`);
  });
}
