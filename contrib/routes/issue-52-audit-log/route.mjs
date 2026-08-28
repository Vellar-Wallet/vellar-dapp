// Mock GET route returning a fixed array of sample audit log entries. No chain
// or DB access.
import http from "node:http";

const MOCK_AUDIT_LOG = [
  {
    actor: "user_1001",
    action: "wallet.created",
    timestamp: "2025-03-01T08:15:22Z",
  },
  {
    actor: "user_1001",
    action: "policy.updated",
    timestamp: "2025-03-01T09:02:47Z",
  },
  {
    actor: "admin_2001",
    action: "contract.verified",
    timestamp: "2025-03-02T11:30:05Z",
  },
  {
    actor: "user_1002",
    action: "transaction.signed",
    timestamp: "2025-03-02T16:44:19Z",
  },
  {
    actor: "system",
    action: "session.expired",
    timestamp: "2025-03-03T00:00:00Z",
  },
  {
    actor: "admin_2001",
    action: "trustline.removed",
    timestamp: "2025-03-03T13:21:58Z",
  },
];

export function handleRequest() {
  return { status: 200, body: { entries: MOCK_AUDIT_LOG } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/audit-log") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4052;
  server.listen(port, () => {
    console.log(`audit-log mock listening on http://localhost:${port}/audit-log`);
  });
}
