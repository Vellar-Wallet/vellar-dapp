// Mock GET route returning a fixed list of supported asset codes and their
// display names. No chain or DB access — the list is hard-coded.
import http from "node:http";
import { URL } from "node:url";

const SUPPORTED_ASSETS = [
  { code: "XLM", name: "Stellar Lumens" },
  { code: "USDC", name: "USD Coin" },
  { code: "USDT", name: "Tether USD" },
  { code: "EURC", name: "Euro Coin" },
  { code: "AQUA", name: "Aquarius" },
  { code: "yXLM", name: "Yield XLM" },
  { code: "BTC", name: "Bitcoin" },
  { code: "ETH", name: "Ethereum" },
  { code: "SHX", name: "Stronghold Token" },
  { code: "NGNT", name: "Nigerian Naira Token" },
];

// Case-insensitive prefix match against the asset code. A missing, empty or
// whitespace-only search returns the full list rather than an empty one.
function filterByCodePrefix(assets, search) {
  if (typeof search !== "string") return assets;
  const prefix = search.trim().toLowerCase();
  if (prefix === "") return assets;
  return assets.filter((asset) => asset.code.toLowerCase().startsWith(prefix));
}

export function handleRequest({ query = {} } = {}) {
  const items = filterByCodePrefix(SUPPORTED_ASSETS, query.search);

  return {
    status: 200,
    body: {
      items,
      total: items.length,
      search: typeof query.search === "string" ? query.search : null,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/supported-assets") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4037;
  server.listen(port, () => {
    console.log(
      `supported-assets mock listening on http://localhost:${port}/supported-assets?search=`,
    );
  });
}
