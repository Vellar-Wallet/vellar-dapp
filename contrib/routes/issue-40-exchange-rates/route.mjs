import http from "node:http";
import { URL } from "node:url";

const MOCK_RATES = [
  { base: "XLM", quote: "USD", rate: "0.12" },
  { base: "XLM", quote: "EUR", rate: "0.11" },
  { base: "BTC", quote: "USD", rate: "68500.00" },
  { base: "BTC", quote: "XLM", rate: "570833.33" },
  { base: "ETH", quote: "USD", rate: "3450.00" },
  { base: "ETH", quote: "XLM", rate: "28750.00" },
];

export function handleRequest(reqUrl) {
  if (!reqUrl) return { status: 200, body: { rates: MOCK_RATES } };

  const parsed = new URL(reqUrl, "http://localhost");
  const base = parsed.searchParams.get("base");
  if (base) {
    const filtered = MOCK_RATES.filter(
      (r) => r.base.toUpperCase() === base.toUpperCase(),
    );
    return { status: 200, body: { rates: filtered } };
  }
  return { status: 200, body: { rates: MOCK_RATES } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/exchange-rates")) {
      const { status, body } = handleRequest(req.url);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4040;
  server.listen(port, () => {
    console.log(
      `exchange-rates mock listening on http://localhost:${port}/exchange-rates`,
    );
  });
}
