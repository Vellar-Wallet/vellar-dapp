// Mock GET route listing sample transactions filtered by a date range. No
// chain or DB access.
import http from "node:http";
import { pathToFileURL, URL } from "node:url";

// Deliberately unsorted and spread across several months so range filtering
// has something to actually do.
const TRANSACTIONS = [
  { id: "tx_05", amount: "75.0000000", asset: "XLM", timestamp: "2026-03-22T18:03:00Z" },
  { id: "tx_11", amount: "22.1000000", asset: "XLM", timestamp: "2026-07-19T08:05:00Z" },
  { id: "tx_01", amount: "50.0000000", asset: "XLM", timestamp: "2026-01-04T09:15:00Z" },
  { id: "tx_04", amount: "3.2500000", asset: "USDC", timestamp: "2026-03-01T23:59:59Z" },
  { id: "tx_08", amount: "96.4000000", asset: "USDC", timestamp: "2026-06-11T11:59:00Z" },
  { id: "tx_02", amount: "12.5000000", asset: "USDC", timestamp: "2026-02-17T14:32:00Z" },
  { id: "tx_12", amount: "64.8000000", asset: "USDC", timestamp: "2026-08-02T13:37:00Z" },
  { id: "tx_06", amount: "410.7500000", asset: "USDC", timestamp: "2026-04-09T06:44:00Z" },
  { id: "tx_03", amount: "200.0000000", asset: "XLM", timestamp: "2026-03-01T00:00:00Z" },
  { id: "tx_09", amount: "5.0000000", asset: "XLM", timestamp: "2026-06-28T02:47:00Z" },
  { id: "tx_07", amount: "18.0000000", asset: "XLM", timestamp: "2026-05-30T21:10:00Z" },
  { id: "tx_10", amount: "150.0000000", asset: "USDC", timestamp: "2026-07-03T16:20:00Z" },
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Parses a bound into epoch milliseconds, or returns null when the value is
// absent or unusable. A bare YYYY-MM-DD is read as UTC midnight; for the upper
// bound it is widened to the end of that day so `to=2026-03-01` includes
// everything that happened on the 1st rather than only the midnight tick.
function parseBound(rawValue, { endOfDay = false } = {}) {
  if (typeof rawValue !== "string" || rawValue === "") return null;

  if (DATE_ONLY.test(rawValue)) {
    const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const parsed = Date.parse(`${rawValue}${suffix}`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const parsed = Date.parse(rawValue);
  return Number.isNaN(parsed) ? null : parsed;
}

export function handleRequest({ query = {} } = {}) {
  // An unparseable bound is dropped rather than rejected: this route always
  // answers with a list, so an unusable filter simply does not narrow it.
  const from = parseBound(query.from);
  const to = parseBound(query.to, { endOfDay: true });

  const transactions = TRANSACTIONS.filter((tx) => {
    const at = Date.parse(tx.timestamp);
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return { status: 200, body: transactions };
}

// pathToFileURL rather than a `file://` template: on Windows argv[1] is a
// drive path, which does not compare equal to import.meta.url otherwise.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/transactions-by-date") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4055;
  server.listen(port, () => {
    console.log(
      `transactions-by-date mock listening on http://localhost:${port}/transactions-by-date`,
    );
  });
}
