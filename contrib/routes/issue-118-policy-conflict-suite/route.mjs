import http from "node:http";

const policies = [
  { id: "pol_A", type: "spending-limit", limitPerDay: 500, precedence: 1 },
  { id: "pol_B", type: "spending-limit", limitPerDay: 200, precedence: 2 },
  { id: "pol_C", type: "allowlist", allowedAddresses: ["GABC", "GDEF"], precedence: 0 },
];

function listActive() {
  return { status: 200, body: policies.map(({ id, type }) => ({ id, type })) };
}

function checkTransfer(body) {
  const { amount, toAddress } = body || {};
  if (typeof amount !== "number" || !toAddress) {
    return { status: 400, body: { error: "amount (number) and toAddress (string) required" } };
  }

  const governing = [];
  for (const p of policies) {
    if (p.type === "spending-limit" && amount > p.limitPerDay) {
      governing.push({ policyId: p.id, reason: `amount ${amount} exceeds limit ${p.limitPerDay}`, precedence: p.precedence });
    }
    if (p.type === "allowlist" && !p.allowedAddresses.includes(toAddress)) {
      governing.push({ policyId: p.id, reason: `address ${toAddress} not in allowlist`, precedence: p.precedence });
    }
  }

  if (governing.length === 0) {
    return { status: 200, body: { allowed: true, governedBy: null, reason: "no policy blocks this transfer" } };
  }

  governing.sort((a, b) => b.precedence - a.precedence);
  const winner = governing[0];
  return { status: 200, body: { allowed: false, governedBy: winner.policyId, reason: winner.reason, allConflicts: governing } };
}

export function handleRequest(method, url, body) {
  if (method === "GET" && url === "/list-active") return listActive();
  if (method === "POST" && url === "/check-transfer") return checkTransfer(body);
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      const { status, body: resp } = handleRequest(req.method, req.url, parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  const port = process.env.PORT || 4118;
  server.listen(port, () => {
    console.log(`policy-conflict mock listening on http://localhost:${port}`);
  });
}
