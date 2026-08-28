// Mock route returning a sample deposit address and memo for an account id.
// In-memory sample dataset only, no chain or database access.
import http from "node:http";
import { URL } from "node:url";

const DEPOSIT_ADDRESSES = {
  acct_001: {
    address: "GA111DEPOSITXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    memo: "100231",
  },
  acct_002: {
    address: "GB222DEPOSITXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    memo: "100232",
  },
};

export function getDepositAddress(accountId) {
  const entry = DEPOSIT_ADDRESSES[accountId];
  if (!entry) {
    return {
      status: 404,
      body: { error: "not_found", message: `no deposit address for account ${accountId}` },
    };
  }
  return {
    status: 200,
    body: { accountId, address: entry.address, memo: entry.memo },
  };
}

export function handleRequest({ method = "GET", path = "" } = {}) {
  const match = path.match(/^\/deposit-address\/([^/]+)$/);
  if (match) {
    return method === "GET"
      ? getDepositAddress(match[1])
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
  const port = process.env.PORT || 4131;
  server.listen(port, () => {
    console.log(
      `deposit-address mock listening on http://localhost:${port}/deposit-address/{accountId}`,
    );
  });
}
