import http from "node:http";

// Mock state for the trust settings screen.
let policyState = {
  attached: false,
  mode: null,
  registryAddress: null,
  contractId: null,
  attachedAt: null,
};

const VALID_AUTH_TOKEN = "passkey-sig-valid";

const ENFORCEMENT_DESCRIPTOR =
  "This policy contract checks whether the target contract of each transaction " +
  "is registered in the verified registry. Verification means the published source " +
  "reproducibly matches the deployed bytecode — it does not mean the contract is " +
  "audited, benign, or safe to use.";

function getStatus() {
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

function attach(body) {
  if (!body || !body.registryAddress) {
    return { status: 422, body: { error: "registryAddress is required" } };
  }
  if (!/^C[A-Z2-7]{55}$/.test(body.registryAddress)) {
    return {
      status: 422,
      body: { error: "registryAddress must be a valid Stellar contract address (C…)" },
    };
  }
  const mode = body.enforcementMode ?? "strict";
  if (!["strict", "trusted_publishers"].includes(mode)) {
    return { status: 422, body: { error: "enforcementMode must be strict or trusted_publishers" } };
  }

  policyState = {
    attached: true,
    mode,
    registryAddress: body.registryAddress,
    contractId: "C" + "A".repeat(55).slice(1),
    attachedAt: new Date().toISOString(),
  };

  return {
    status: 201,
    body: {
      attached: true,
      mode,
      contractId: policyState.contractId,
      attachedAt: policyState.attachedAt,
    },
  };
}

function revoke(body) {
  if (!body || body.authToken !== VALID_AUTH_TOKEN) {
    return { status: 403, body: { error: "passkey authorization required" } };
  }
  if (!policyState.attached) {
    return { status: 200, body: { removed: false, reason: "no_policy_attached" } };
  }

  policyState = {
    attached: false,
    mode: null,
    registryAddress: null,
    contractId: null,
    attachedAt: null,
  };

  return { status: 200, body: { removed: true } };
}

function getDescriptor() {
  return {
    status: 200,
    body: {
      descriptor: ENFORCEMENT_DESCRIPTOR,
      caveats: [
        "Verification does not imply the contract is audited or safe.",
        "A verified contract can still behave unexpectedly.",
        "A verified contract is not audited, benign, or guaranteed safe.",
      ],
    },
  };
}

export function handleRequest(method, url, body) {
  if (method === "GET" && url === "/trust/status") return getStatus();
  if (method === "POST" && url === "/trust/attach") return attach(body);
  if (method === "POST" && url === "/trust/revoke") return revoke(body);
  if (method === "GET" && url === "/trust/descriptor") return getDescriptor();
  return { status: 404, body: { error: "not_found" } };
}

// Allow tests to reset state between runs.
export function resetState() {
  policyState = {
    attached: false,
    mode: null,
    registryAddress: null,
    contractId: null,
    attachedAt: null,
  };
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
  const port = process.env.PORT || 4009;
  server.listen(port, () => {
    console.log(`trust-settings mock listening on http://localhost:${port}`);
  });
}
