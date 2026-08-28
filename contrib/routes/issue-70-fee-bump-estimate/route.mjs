// Mock route module simulating fee bump transaction estimation. No chain
// or DB access; fees come from a fixed per-priority lookup table.
import http from "node:http";

const FEE_TABLE = {
  low: 100,
  medium: 500,
  high: 2000,
};

const VALID_HASH = /^[0-9a-fA-F]{8,64}$/;

export function handleRequest(body) {
  if (!body || typeof body.txHash !== "string" || !body.txHash) {
    return { status: 400, body: { error: "tx_hash_required" } };
  }
  if (!VALID_HASH.test(body.txHash)) {
    return { status: 400, body: { error: "invalid_tx_hash" } };
  }

  const priority = typeof body.priority === "string" ? body.priority.toLowerCase() : body.priority;
  if (!priority || !(priority in FEE_TABLE)) {
    return {
      status: 400,
      body: { error: "invalid_priority", message: "priority must be one of: low, medium, high" },
    };
  }

  return {
    status: 200,
    body: {
      txHash: body.txHash,
      priority,
      suggestedFee: FEE_TABLE[priority],
      unit: "stroops",
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/fee-bump-estimate") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          const { status, body: resp } = handleRequest(body);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4070;
  server.listen(port, () => {
    console.log(
      `fee-bump-estimate mock listening on http://localhost:${port}/fee-bump-estimate`,
    );
  });
}
