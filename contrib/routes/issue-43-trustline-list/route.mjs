import http from "node:http";

const MOCK_TRUSTLINES = [
  {
    assetCode: "XLM",
    issuer: "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
    balance: "1250.5000000",
  },
  {
    assetCode: "USDC",
    issuer: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    balance: "500.0000000",
  },
  {
    assetCode: "EURC",
    issuer: "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    balance: "320.7500000",
  },
  {
    assetCode: "BTC",
    issuer: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    balance: "0.0500000",
  },
];

export function handleRequest() {
  return { status: 200, body: { trustlines: MOCK_TRUSTLINES } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/trustline-list") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4043;
  server.listen(port, () => {
    console.log(
      `trustline-list mock listening on http://localhost:${port}/trustline-list`,
    );
  });
}
