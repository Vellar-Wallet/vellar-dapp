import http from "node:http";
import url from "node:url";

/**
 * Mock GET Route: Transactions Filtered by Date (Issue #29)
 * Returns sample transactions filtered by optional 'from' and 'to' date parameters.
 */
export const SAMPLE_TRANSACTIONS = [
  { id: "tx-101", amount: "50.00", asset: "XLM", createdAt: "2026-07-01T10:00:00Z" },
  { id: "tx-102", amount: "120.50", asset: "USDC", createdAt: "2026-07-05T14:30:00Z" },
  { id: "tx-103", amount: "15.00", asset: "XLM", createdAt: "2026-07-10T09:15:00Z" },
  { id: "tx-104", amount: "200.00", asset: "EURC", createdAt: "2026-07-15T18:45:00Z" },
  { id: "tx-105", amount: "1000.00", asset: "XLM", createdAt: "2026-07-20T11:20:00Z" },
  { id: "tx-106", amount: "75.25", asset: "USDC", createdAt: "2026-07-25T16:10:00Z" },
  { id: "tx-107", amount: "30.00", asset: "XLM", createdAt: "2026-07-28T08:00:00Z" },
];

export function filterTransactionsByDate(transactions, fromDate, toDate) {
  return transactions.filter(tx => {
    const txTime = new Date(tx.createdAt).getTime();
    if (fromDate && txTime < new Date(fromDate).getTime()) return false;
    if (toDate && txTime > new Date(toDate).getTime()) return false;
    return true;
  });
}

export function handleTransactionsByDateRequest(req, res) {
  if (req.method === "GET") {
    const parsedUrl = url.parse(req.url, true);
    const { from, to } = parsedUrl.query;
    
    const filtered = filterTransactionsByDate(SAMPLE_TRANSACTIONS, from, to);
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "success",
      count: filtered.length,
      from: from || null,
      to: to || null,
      transactions: filtered
    }));
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed. Use GET." }));
}

const PORT = process.env.PORT || 4029;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    handleTransactionsByDateRequest(req, res);
  });

  server.listen(PORT, () => {
    console.log(`transactions-by-date mock listening on http://localhost:${PORT}/transactions-by-date`);
  });
}
