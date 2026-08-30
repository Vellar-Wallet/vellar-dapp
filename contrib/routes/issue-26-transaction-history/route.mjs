// Mock GET route listing sample transaction history. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

const MOCK_TRANSACTIONS = [
  {
    hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    amount: "50.0000000",
    timestamp: "2026-07-20T09:15:00Z",
  },
  {
    hash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    amount: "12.5000000",
    timestamp: "2026-07-21T14:32:00Z",
  },
  {
    hash: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    amount: "200.0000000",
    timestamp: "2026-07-23T02:47:00Z",
  },
  {
    hash: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
    amount: "3.2500000",
    timestamp: "2026-07-25T18:03:00Z",
  },
  {
    hash: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
    amount: "75.0000000",
    timestamp: "2026-07-27T11:59:00Z",
  },
];

function parseLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") return undefined;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function handleRequest({ query = {} } = {}) {
  const limit = parseLimit(query.limit);
  const transactions = limit === undefined ? MOCK_TRANSACTIONS : MOCK_TRANSACTIONS.slice(0, limit);
  return { status: 200, body: transactions };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/transactions") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4026;
  server.listen(port, () => {
    console.log(`transaction-history mock listening on http://localhost:${port}/transactions`);
  });
}
