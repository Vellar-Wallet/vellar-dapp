import http from "node:http";

const MOCK_TRANSACTIONS = {
  "abc123def456": {
    hash: "abc123def456",
    amount: "100.0000000",
    assetCode: "XLM",
    from: "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
    to: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    timestamp: "2026-07-27T12:00:00Z",
    memo: "payment for services",
  },
  "xyz789ghi012": {
    hash: "xyz789ghi012",
    amount: "500.5000000",
    assetCode: "USDC",
    from: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    to: "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    timestamp: "2026-07-27T13:30:00Z",
    memo: "invoice #1234",
  },
};

export function handleRequest(hash) {
  if (!hash) {
    return { status: 400, body: { error: "hash_required" } };
  }
  const tx = MOCK_TRANSACTIONS[hash];
  if (!tx) {
    return { status: 404, body: { error: "transaction_not_found" } };
  }
  return { status: 200, body: tx };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/transaction\/([a-zA-Z0-9]+)$/);
    if (req.method === "GET" && match) {
      const { status, body } = handleRequest(match[1]);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4041;
  server.listen(port, () => {
    console.log(
      `transaction-detail mock listening on http://localhost:${port}/transaction/<hash>`,
    );
  });
}
