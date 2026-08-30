// Mock route module for allowlist/denylist recipients. In-memory only,
// no chain or DB access. State resets whenever the process restarts.
import http from "node:http";
import { URL } from "node:url";

const LISTS = {
  allow: new Set(["GA111ALLOWEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]),
  deny: new Set(["GB222DENIEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]),
};

function normalizeType(type) {
  return typeof type === "string" ? type.toLowerCase() : type;
}

export function handleAdd(body) {
  if (!body || typeof body.recipient !== "string" || !body.recipient) {
    return { status: 400, body: { error: "recipient_required" } };
  }
  const type = normalizeType(body.type);
  if (type !== "allow" && type !== "deny") {
    return { status: 400, body: { error: "invalid_list_type", message: "type must be 'allow' or 'deny'" } };
  }

  LISTS[type].add(body.recipient);
  return {
    status: 200,
    body: { added: true, type, recipient: body.recipient },
  };
}

export function handleCheck(query = {}) {
  const recipient = query.recipient;
  if (!recipient) {
    return { status: 400, body: { error: "recipient_required" } };
  }

  if (LISTS.allow.has(recipient)) {
    return { status: 200, body: { recipient, list: "allow" } };
  }
  if (LISTS.deny.has(recipient)) {
    return { status: 200, body: { recipient, list: "deny" } };
  }
  return { status: 200, body: { recipient, list: null } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/recipient-lists/add") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          const { status, body: resp } = handleAdd(body);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/recipient-lists/check") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleCheck(query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4075;
  server.listen(port, () => {
    console.log(
      `recipient-lists mock listening on http://localhost:${port}/recipient-lists/{add,check}`,
    );
  });
}
