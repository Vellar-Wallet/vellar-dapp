// Mock GET route returning a fixed list of sample policy templates, each
// describing its configurable parameters via a schema. No chain or DB
// access.
import http from "node:http";

const TEMPLATES = [
  {
    id: "tpl_spending_limit",
    name: "spending-limit",
    description: "Caps the total amount that can be spent within a rolling time window.",
    parameters: [
      { name: "maxAmount", type: "string", required: true },
      { name: "asset", type: "string", required: true },
      { name: "windowSeconds", type: "number", required: true },
    ],
  },
  {
    id: "tpl_allowlist",
    name: "allowlist",
    description: "Restricts outgoing payments to a fixed set of pre-approved recipient addresses.",
    parameters: [
      { name: "allowedRecipients", type: "string[]", required: true },
      { name: "allowUnlistedBelow", type: "string", required: false },
    ],
  },
  {
    id: "tpl_multisig",
    name: "multisig",
    description: "Requires a minimum number of signer approvals before a transaction is executed.",
    parameters: [
      { name: "signers", type: "string[]", required: true },
      { name: "threshold", type: "number", required: true },
    ],
  },
  {
    id: "tpl_time_lock",
    name: "time-lock",
    description: "Delays execution of a transaction until a specified time has elapsed.",
    parameters: [
      { name: "delaySeconds", type: "number", required: true },
      { name: "cancellable", type: "boolean", required: false },
    ],
  },
];

export function handleRequest() {
  return { status: 200, body: { templates: TEMPLATES } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/policy-templates") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4064;
  server.listen(port, () => {
    console.log(`policy-templates mock listening on http://localhost:${port}/policy-templates`);
  });
}
