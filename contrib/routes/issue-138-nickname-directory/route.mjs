// Mock route module for a recipient nickname directory. Maintains a
// nickname -> address map with add, lookup, and remove endpoints.
// In-memory only, no chain or DB access. State resets whenever the
// process restarts.
import http from "node:http";
import { URL } from "node:url";

const directory = new Map([["alice", "GA111ALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]]);

export function handleAdd(body) {
  if (!body || typeof body.nickname !== "string" || !body.nickname) {
    return { status: 400, body: { error: "nickname_required" } };
  }
  if (typeof body.address !== "string" || !body.address) {
    return { status: 400, body: { error: "address_required" } };
  }

  if (directory.has(body.nickname)) {
    return {
      status: 409,
      body: {
        error: "nickname_exists",
        message: `Nickname "${body.nickname}" is already in use`,
      },
    };
  }

  directory.set(body.nickname, body.address);
  return {
    status: 200,
    body: { added: true, nickname: body.nickname, address: body.address },
  };
}

export function handleLookup(nickname) {
  const address = directory.get(nickname);
  if (!address) {
    return {
      status: 404,
      body: {
        error: "nickname_not_found",
        message: `No entry found for nickname "${nickname}"`,
      },
    };
  }
  return { status: 200, body: { nickname, address } };
}

export function handleRemove(nickname) {
  if (!directory.has(nickname)) {
    return {
      status: 404,
      body: {
        error: "nickname_not_found",
        message: `No entry found for nickname "${nickname}"`,
      },
    };
  }
  directory.delete(nickname);
  return { status: 200, body: { removed: true, nickname } };
}

/** Test-only helper to reset in-memory state between test files/runs. */
export function _resetDirectory() {
  directory.clear();
  directory.set("alice", "GA111ALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/nicknames") {
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
        const { status, body: responseBody } = handleAdd(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    const entryMatch = url.pathname.match(/^\/nicknames\/([^/]+)$/);
    if (req.method === "GET" && entryMatch) {
      const { status, body } = handleLookup(decodeURIComponent(entryMatch[1]));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "DELETE" && entryMatch) {
      const { status, body } = handleRemove(decodeURIComponent(entryMatch[1]));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4138;
  server.listen(port, () => {
    console.log(
      `nickname-directory mock listening on http://localhost:${port}/nicknames`,
    );
  });
}
