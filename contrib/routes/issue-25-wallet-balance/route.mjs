// Mock GET route returning a static wallet balance. No chain or DB access.
import http from "node:http";

const MOCK_BALANCE = {
  balance: "1250.5000000",
  assetCode: "XLM",
};

export function handleRequest() {
  return { status: 200, body: MOCK_BALANCE };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/wallet-balance") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4025;
  server.listen(port, () => {
    console.log(`wallet-balance mock listening on http://localhost:${port}/wallet-balance`);
  });
}
