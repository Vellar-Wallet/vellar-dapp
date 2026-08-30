import http from "node:http";

// Mock state for the blocked transaction explainer.
const verifiedContracts = new Set();
let acknowledgedWarns = new Set();

// Honest explainer copy — never claims verified means safe.
const BLOCKED_EXPLAINER = {
  title: "Transaction blocked — target contract not verified",
  body: `The target contract's published source has not been verified against the \
deployed bytecode. Verification means the source you can read reproducibly \
matches the code that runs on-chain — it does not mean the contract is \
audited, benign, or safe to use.`,
  action: `You can inspect the contract's verification status on the verification \
explorer. If you are the contract author, submit the source for verification.`,
  explorerLabel: "Open in verification explorer",
};

const WARN_EXPLAINER = {
  title: "Caution — target contract is verified but not audited",
  body: `The target contract's source has been verified: the published code \
reproducibly matches the deployed bytecode. This does not mean the contract \
has been audited, is free of bugs, or is safe to use. Proceed only if you \
trust the contract author.`,
  action: "I understand — proceed anyway",
};

function getBlockedExplainer() {
  return { status: 200, body: { explainer: BLOCKED_EXPLAINER, warn: WARN_EXPLAINER } };
}

function checkTarget(body) {
  if (!body || !body.targetContract) {
    return { status: 422, body: { error: "targetContract is required" } };
  }
  if (!/^C[A-Z2-7]{55}$/.test(body.targetContract)) {
    return {
      status: 422,
      body: { error: "targetContract must be a valid Stellar contract address (C…)" },
    };
  }

  const policyAttached = body.policyAttached === true;
  if (!policyAttached) {
    return { status: 200, body: { allowed: true, reason: null } };
  }

  const isVerified = verifiedContracts.has(body.targetContract);
  if (isVerified) {
    return { status: 200, body: { allowed: true, reason: null } };
  }

  return {
    status: 200,
    body: {
      allowed: false,
      reason: "contract_not_verified",
      explainer: {
        ...BLOCKED_EXPLAINER,
        explorerUrl: `/verify?contract=${body.targetContract}`,
      },
    },
  };
}

function acknowledge(body) {
  if (!body || !body.contractId) {
    return { status: 422, body: { error: "contractId is required" } };
  }
  acknowledgedWarns.add(body.contractId);
  return { status: 200, body: { acknowledged: true, contractId: body.contractId } };
}

// Test helpers — allow tests to register verified contracts and reset.
export function registerVerified(contractId) {
  verifiedContracts.add(contractId);
}

export function resetState() {
  verifiedContracts.clear();
  acknowledgedWarns.clear();
}

export function handleRequest(method, url, body) {
  if (method === "GET" && url === "/explainer/blocked") return getBlockedExplainer();
  if (method === "POST" && url === "/explainer/check") return checkTarget(body);
  if (method === "POST" && url === "/explainer/acknowledge") return acknowledge(body);
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (c) => (bodyStr += c));
    req.on("end", () => {
      let parsed;
      try {
        if (bodyStr) parsed = JSON.parse(bodyStr);
      } catch {}
      const { status, body: resp } = handleRequest(req.method, req.url, parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  const port = process.env.PORT || 4010;
  server.listen(port, () => {
    console.log(`blocked-explainer mock listening on http://localhost:${port}`);
  });
}
