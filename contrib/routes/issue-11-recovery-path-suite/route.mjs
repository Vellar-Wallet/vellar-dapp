import http from "node:http";

// Mock state for the recovery path.
let policyState = {
  attached: false,
  mode: null,
  contractId: null,
};

const VALID_AUTH_TOKEN = "passkey-sig-valid";

const THREAT_MODEL = {
  summary:
    "A session attacker (controls the browser session but not the passkey) " +
    "can initiate transactions but cannot sign them. The verified-only policy " +
    "adds an additional layer: even if a session is compromised, the policy " +
    "rejects transactions to unverified contracts.",
  attackerCapabilities: [
    "Can view the wallet balance and transaction history.",
    "Can initiate transactions in the UI.",
    "Cannot sign transactions (passkey required).",
    "Cannot remove or relax the verified-only policy (passkey required).",
  ],
  ownerCapabilities: [
    "Can always remove the verified-only policy with passkey authorization.",
    "The removal operation itself is never blocked by the policy.",
    "Can relax the policy from strict to trusted_publishers mode.",
  ],
  removalGuarantee:
    "The verified-only policy is designed so that the removal operation is " +
    "never rejected by the policy itself. The account owner can always " +
    "recover by removing the policy with passkey authorization.",
};

function getStatus() {
  return {
    status: 200,
    body: {
      attached: policyState.attached,
      mode: policyState.mode,
      contractId: policyState.contractId,
      recoveryOptions: policyState.attached
        ? ["remove", "relax_to_trusted_publishers"]
        : [],
    },
  };
}

function removePolicy(body) {
  if (!body || body.authToken !== VALID_AUTH_TOKEN) {
    return { status: 403, body: { removed: false, error: "passkey authorization required" } };
  }
  if (!policyState.attached) {
    return { status: 200, body: { removed: false, reason: "no_policy_attached" } };
  }

  policyState = { attached: false, mode: null, contractId: null };
  return { status: 200, body: { removed: true } };
}

function relaxPolicy(body) {
  if (!body || body.authToken !== VALID_AUTH_TOKEN) {
    return { status: 403, body: { relaxed: false, error: "passkey authorization required" } };
  }
  if (!policyState.attached) {
    return { status: 200, body: { relaxed: false, reason: "no_policy_attached" } };
  }
  if (policyState.mode !== "strict") {
    return {
      status: 200,
      body: { relaxed: false, reason: "already_not_strict", currentMode: policyState.mode },
    };
  }

  policyState.mode = "trusted_publishers";
  return { status: 200, body: { relaxed: true, mode: "trusted_publishers" } };
}

function getThreatModel() {
  return { status: 200, body: THREAT_MODEL };
}

// Test helpers.
export function setPolicyState(attached, mode = null, contractId = null) {
  policyState = { attached, mode, contractId };
}

export function resetState() {
  policyState = { attached: false, mode: null, contractId: null };
}

export function handleRequest(method, url, body) {
  if (method === "GET" && url === "/recovery/status") return getStatus();
  if (method === "POST" && url === "/recovery/remove") return removePolicy(body);
  if (method === "POST" && url === "/recovery/relax") return relaxPolicy(body);
  if (method === "GET" && url === "/recovery/threat-model") return getThreatModel();
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
  const port = process.env.PORT || 4011;
  server.listen(port, () => {
    console.log(`recovery-path mock listening on http://localhost:${port}`);
  });
}
