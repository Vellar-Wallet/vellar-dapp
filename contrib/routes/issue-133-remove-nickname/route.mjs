// Mock route removing a recipient nickname. In-memory sample dataset only,
// no chain or database access. State resets whenever the process restarts.
import http from "node:http";
import { URL } from "node:url";

const SEED_NICKNAMES = ["Mum", "Landlord", "Savings Pool"];

let nicknames = new Set(SEED_NICKNAMES);

export function resetState() {
  nicknames = new Set(SEED_NICKNAMES);
}

export function removeNickname(nickname) {
  if (!nicknames.has(nickname)) {
    return {
      status: 404,
      body: { error: "not_found", message: `nickname ${nickname} does not exist` },
    };
  }
  nicknames.delete(nickname);
  return {
    status: 200,
    body: { removed: true, nickname },
  };
}

export function handleRequest({ method = "GET", path = "" } = {}) {
  const match = path.match(/^\/nicknames\/([^/]+)$/);
  if (match) {
    return method === "DELETE"
      ? removeNickname(decodeURIComponent(match[1]))
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const result = handleRequest({ method: req.method, path: url.pathname });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4133;
  server.listen(port, () => {
    console.log(`remove-nickname mock listening on http://localhost:${port}/nicknames/{nickname}`);
  });
}
