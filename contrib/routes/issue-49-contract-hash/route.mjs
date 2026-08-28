// Mock GET route returning the wasm hash for a sample contract id. No chain or
// DB access.
import http from "node:http";

const CONTRACT_HASHES = {
  CA0000000000000000000000000000000000000000000000000001: {
    contractId: "CA0000000000000000000000000000000000000000000000000001",
    wasmHash: "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed",
    network: "testnet",
  },
  CA0000000000000000000000000000000000000000000000000002: {
    contractId: "CA0000000000000000000000000000000000000000000000000002",
    wasmHash: "89e6c98d92887913c7c9f9f5ee0e7f0e0d1a0b1c2d3e4f5061728394a5b6c7d8",
    network: "testnet",
  },
  CA0000000000000000000000000000000000000000000000000003: {
    contractId: "CA0000000000000000000000000000000000000000000000000003",
    wasmHash: "aa0bd10b0f2e5c1c1e6f2b7a8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819",
    network: "futurenet",
  },
};

export function handleRequest({ params = {} } = {}) {
  const { contractId } = params;
  const record = contractId ? CONTRACT_HASHES[contractId] : undefined;

  if (!record) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `No contract found for id "${contractId ?? ""}"`,
      },
    };
  }

  return { status: 200, body: { ...record } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/contracts\/([^/]+)\/hash$/);
    if (req.method === "GET" && match) {
      const { status, body } = handleRequest({
        params: { contractId: decodeURIComponent(match[1]) },
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4049;
  server.listen(port, () => {
    console.log(
      `contract-hash mock listening on http://localhost:${port}/contracts/:contractId/hash`,
    );
  });
}
