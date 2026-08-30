// Mock route module for notification preference management. Get and
// update a sample set of notification preferences per account. In-memory
// only, no chain or DB access. State resets whenever the process
// restarts.
import http from "node:http";
import { URL } from "node:url";

const DEFAULT_PREFS = Object.freeze({
  email: true,
  push: true,
  sms: false,
  marketing: false,
});

// Only accounts that have explicitly updated preferences get an entry
// here; anyone else falls back to DEFAULT_PREFS.
const overrides = new Map();

function prefsFor(accountId) {
  const stored = overrides.get(accountId);
  return stored ? { ...DEFAULT_PREFS, ...stored } : { ...DEFAULT_PREFS };
}

export function handleGet(accountId) {
  if (!accountId) {
    return { status: 400, body: { error: "account_id_required" } };
  }
  return { status: 200, body: { accountId, preferences: prefsFor(accountId) } };
}

export function handleUpdate(accountId, body) {
  if (!accountId) {
    return { status: 400, body: { error: "account_id_required" } };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_request", message: "Body must be an object" } };
  }

  const allowedKeys = Object.keys(DEFAULT_PREFS);
  const invalidKeys = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (invalidKeys.length > 0) {
    return {
      status: 400,
      body: { error: "invalid_field", message: `Unknown preference field(s): ${invalidKeys.join(", ")}` },
    };
  }

  const current = prefsFor(accountId);
  const updated = { ...current, ...body };
  overrides.set(accountId, updated);

  return { status: 200, body: { accountId, preferences: updated } };
}

/** Test-only helper to reset in-memory state between test files/runs. */
export function _resetPrefs() {
  overrides.clear();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/notification-prefs\/([^/]+)$/);

    if (req.method === "GET" && match) {
      const { status, body } = handleGet(decodeURIComponent(match[1]));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "PATCH" && match) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json", message: "Request body must be valid JSON" }));
          return;
        }
        const { status, body: responseBody } = handleUpdate(decodeURIComponent(match[1]), body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4139;
  server.listen(port, () => {
    console.log(
      `notification-prefs mock listening on http://localhost:${port}/notification-prefs/:accountId`,
    );
  });
}
