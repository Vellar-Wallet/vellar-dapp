import http from "node:http";

export function generateCleanupPlan({
  accountId,
  destination,
  linkedAssets = [],
  pendingTransactions = [],
}) {
  const blockers = [];

  // 1. Evaluate linked assets
  for (const asset of linkedAssets) {
    blockers.push({
      type: "trustline",
      description: `Active trustline for asset ${asset.code}:${asset.issuer}`,
      actionRequired: "Remove trustline or transfer asset balance to destination",
    });
  }

  // 2. Evaluate pending transactions
  if (pendingTransactions.length > 0) {
    blockers.push({
      type: "offer",
      description: `Account has ${pendingTransactions.length} pending transaction(s) or open offer(s)`,
      actionRequired: "Cancel pending transactions or wait for settlement",
    });
  }

  const estimatedTransactions = blockers.length + 1; // blockers + final merge transaction
  const mergeReady = blockers.length === 0;

  return {
    accountId,
    destination,
    blockers,
    estimatedTransactions,
    mergeReady,
  };
}

export function handleRequest(req) {
  const body = req.body || {};
  const plan = generateCleanupPlan({
    accountId: body.accountId || "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
    destination: body.destination || "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
    linkedAssets: body.linkedAssets || [],
    pendingTransactions: body.pendingTransactions || [],
  });
  return { status: 200, body: { plan } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (chunk) => (bodyStr += chunk));
    req.on("end", () => {
      let body = {};
      try {
        if (bodyStr) body = JSON.parse(bodyStr);
      } catch {}
      const { status, body: resBody } = handleRequest({ body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  const port = process.env.PORT || 4320;
  server.listen(port, () => console.log(`issue-320 mock listening on port ${port}`));
}
