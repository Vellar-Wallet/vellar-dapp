import http from "node:http";

// Mock state for the verified-only signing E2E suite.
let policyState = {
  attached: false,
  mode: null,
  contractId: null,
  attachedAt: null,
};

const verifiedContracts = new Set();
const VALID_AUTH_TOKEN = "passkey-sig-valid";

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

function getPolicyStatus() {
  return {
    status: 200,
    body: {
      attached: policyState.attached,
      mode: policyState.mode,
      contractId: policyState.contractId,
      attachedAt: policyState.attachedAt,
    },
  };
}

function attachPolicy(body) {
  if (!body || !body.registryAddress) {
    return { status: 422, body: { error: "registryAddress is required" } };
  }
  if (!/^C[A-Z2-7]{55}$/.test(body.registryAddress)) {
    return { status: 422, body: { error: "registryAddress must be a valid contract address" } };
  }
  const mode = body.enforcementMode ?? "strict";
  if (!["strict", "trusted_publishers"].includes(mode)) {
    return { status: 422, body: { error: "enforcementMode must be strict or trusted_publishers" } };
  }

  policyState = {
    attached: true,
    mode,
    contractId: "C" + "1".repeat(55).slice(1),
    attachedAt: new Date().toISOString(),
  };

  return {
    status: 201,
    body: { attached: true, mode, contractId: policyState.contractId },
  };
}

function removePolicy(body) {
  if (!body || body.authToken !== VALID_AUTH_TOKEN) {
    return { status: 403, body: { removed: false, error: "passkey authorization required" } };
  }
  if (!policyState.attached) {
    return { status: 200, body: { removed: false, reason: "no_policy_attached" } };
  }

  policyState = { attached: false, mode: null, contractId: null, attachedAt: null };
  return { status: 200, body: { removed: true } };
}

function checkTransaction(body) {
  if (!body || !body.targetContract) {
    return { status: 422, body: { error: "targetContract is required" } };
  }
  if (!/^C[A-Z2-7]{55}$/.test(body.targetContract)) {
    return { status: 422, body: { error: "targetContract must be a valid contract address" } };
  }

  // No policy → always allowed.
  if (!policyState.attached) {
    return { status: 200, body: { allowed: true, reason: null } };
  }

  // Policy attached → check verification status.
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

function getVerification(contractId) {
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    return { status: 422, body: { error: "invalid contract address" } };
  }
  const isVerified = verifiedContracts.has(contractId);
  return {
    status: 200,
    body: {
      contractId,
      status: isVerified ? "verified" : "unverified",
      records: isVerified
        ? [
            {
              id: "rec-1",
              contractId,
              sourceType: "repo",
              repoUrl: "https://github.com/example/contract",
              commitHash: "a1b2c3d",
              toolchainVersion: "1.94.0",
              outputHash: "0f6b858d".padEnd(64, "0"),
              deployedHash: "0f6b858d".padEnd(64, "0"),
              status: "verified",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]
        : [],
    },
  };
}

function getBlockedExplainer() {
  return { status: 200, body: { explainer: BLOCKED_EXPLAINER } };
}

function getThreatModel() {
  return { status: 200, body: THREAT_MODEL };
}

// Test helpers.
export function registerVerified(contractId) {
  verifiedContracts.add(contractId);
}

export function setPolicyState(attached, mode = null, contractId = null) {
  policyState = {
    attached,
    mode,
    contractId,
    attachedAt: attached ? new Date().toISOString() : null,
  };
}

export function resetState() {
  policyState = { attached: false, mode: null, contractId: null, attachedAt: null };
  verifiedContracts.clear();
}

export function handleRequest(method, url, body) {
  if (method === "GET" && url === "/policy/status") return getPolicyStatus();
  if (method === "POST" && url === "/policy/attach") return attachPolicy(body);
  if (method === "POST" && url === "/policy/remove") return removePolicy(body);
  if (method === "POST" && url === "/transaction/check") return checkTransaction(body);
  if (method === "GET" && url === "/explainer/blocked") return getBlockedExplainer();
  if (method === "GET" && url === "/recovery/threat-model") return getThreatModel();

  // /verification/:contractId — extract contractId from URL
  const verifyMatch = url.match(/^\/verification\/([A-Z2-7]{56})$/);
  if (method === "GET" && verifyMatch) return getVerification(verifyMatch[1]);

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
  const port = process.env.PORT || 4012;
  server.listen(port, () => {
    console.log(`verified-only e2e mock listening on http://localhost:${port}`);
  });
}
