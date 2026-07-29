import http from "node:http";

/**
 * Mock GET Route: Fee Estimates (Issue #31)
 * Returns network fee estimates for low, medium, and high priority tiers in stroops.
 */
export const FEE_ESTIMATES = {
  low: 100,      // Minimum base fee (100 stroops = 0.00001 XLM)
  medium: 500,    // Standard network priority fee (500 stroops)
  high: 1000,    // High priority expedited fee (1000 stroops)
};

export function handleFeeEstimatesRequest(req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "success",
      unit: "stroops",
      fees: FEE_ESTIMATES
    }));
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed. Use GET." }));
}

// Route server listener stub (30% implementation scaffold)
const PORT = process.env.PORT || 4031;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/fee-estimates" || req.url === "/") {
      handleFeeEstimatesRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`fee-estimates mock listening on http://localhost:${PORT}/fee-estimates`);
  });
}
