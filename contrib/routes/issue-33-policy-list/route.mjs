// Mock GET route returning a fixed list of sample account policy summaries.
// No chain or DB access.
import http from "node:http";

const POLICIES = [
  { id: "pol_1001", type: "spending-limit", status: "active" },
  { id: "pol_1002", type: "spending-limit", status: "paused" },
  { id: "pol_1003", type: "allowlist", status: "active" },
  { id: "pol_1004", type: "time-lock", status: "active" },
  { id: "pol_1005", type: "multi-sig", status: "revoked" },
];

export function handleRequest() {
  return { status: 200, body: POLICIES };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/policies") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4033;
  server.listen(port, () => {
    console.log(`policy-list mock listening on http://localhost:${port}/policies`);
  });
}
