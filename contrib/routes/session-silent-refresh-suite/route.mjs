import http from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const SESSION_ID = "sample-session";

function response(status, body) {
  return { status, body };
}

function currentTime(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function createState({ now = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  return {
    now: currentTime(now),
    graceMs,
    session: {
      id: SESSION_ID,
      expiresAt: null,
      status: "active",
    },
  };
}

function sessionStatus(state, now) {
  const expired = now >= state.session.expiresAt;
  return response(200, {
    sessionId: state.session.id,
    expiresAt: state.session.expiresAt,
    status: expired ? "expired" : "active",
  });
}

export function handleRequest(
  method,
  url,
  body = {},
  query = {},
  state = createState(),
) {
  const now = currentTime(body?.now ?? query?.now ?? state.now);
  state.now = now;

  if (method === "POST" && url === "/session/expire") {
    const expiresAt = currentTime(body?.expiresAt ?? now);
    state.session.expiresAt = expiresAt;
    state.session.status = "expired";
    return response(200, {
      sessionId: state.session.id,
      expiresAt,
      status: "expired",
    });
  }

  if (method === "GET" && url === "/session/check-session") {
    if (state.session.expiresAt === null) {
      return response(200, {
        sessionId: state.session.id,
        status: "active",
        expiresAt: null,
      });
    }
    return sessionStatus(state, now);
  }

  if (method === "POST" && url === "/session/silent-refresh") {
    if (state.session.expiresAt === null || now < state.session.expiresAt) {
      return response(409, {
        error: "session_not_expired",
        message: "silent refresh is available after session expiry",
      });
    }

    const elapsed = now - state.session.expiresAt;
    if (elapsed > state.graceMs) {
      return response(401, {
        error: "reauthentication_required",
        message: "silent refresh grace period has elapsed",
      });
    }

    const refreshedUntil = now + state.graceMs;
    state.session.expiresAt = refreshedUntil;
    state.session.status = "active";
    return response(200, {
      sessionId: state.session.id,
      refreshed: true,
      status: "active",
      expiresAt: refreshedUntil,
      graceMs: state.graceMs,
    });
  }

  return response(404, { error: "not_found" });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry !== null && import.meta.url === entry) {
  const state = createState();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result = body === null
      ? response(400, { error: "invalid_json" })
      : handleRequest(req.method, url.pathname, body, Object.fromEntries(url.searchParams), state);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4112;
  server.listen(port, () => {
    console.log(`session-silent-refresh suite listening on http://localhost:${port}`);
  });
}