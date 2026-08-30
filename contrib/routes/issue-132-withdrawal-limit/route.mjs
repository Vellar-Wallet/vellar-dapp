// Mock route returning a sample daily withdrawal limit and amount used for
// an account. In-memory sample dataset only, no chain or database access.
import http from "node:http";
import { URL } from "node:url";

const WITHDRAWAL_LIMITS = {
  acct_001: { limit: 5000, used: 1250 },
  acct_002: { limit: 10000, used: 10000 },
};

const DEFAULT_LIMIT = { limit: 1000, used: 0 };

export function getWithdrawalLimit(accountId) {
  const entry = WITHDRAWAL_LIMITS[accountId] ?? DEFAULT_LIMIT;
  return {
    status: 200,
    body: {
      accountId,
      limit: entry.limit,
      used: entry.used,
      remaining: entry.limit - entry.used,
    },
  };
}

export function handleRequest({ method = "GET", path = "" } = {}) {
  const match = path.match(/^\/withdrawal-limit\/([^/]+)$/);
  if (match) {
    return method === "GET"
      ? getWithdrawalLimit(match[1])
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
  const port = process.env.PORT || 4132;
  server.listen(port, () => {
    console.log(
      `withdrawal-limit mock listening on http://localhost:${port}/withdrawal-limit/{accountId}`,
    );
  });
}
