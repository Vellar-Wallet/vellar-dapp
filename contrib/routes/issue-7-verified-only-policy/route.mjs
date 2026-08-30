import http from "node:http";

export const VERIFIED_ONLY_POLICY_WASM_HASH =
  "9e73b22b10a3c2b1892d77bc3e934a1b0292f7d23a19b8849b293848123abc45";

export const VERIFIED_ONLY_TEMPLATE = {
  type: "verified_only",
  title: "Verified contracts only",
  description:
    "Restrict signing to transactions interacting with contracts verified in the verified registry.",
  parameters: [
    { name: "registryAddress", type: "string", required: true },
    { name: "enforcementMode", type: "enum", options: ["strict", "trusted_publishers"], default: "strict" },
  ],
  enforcement: {
    kind: "policy-contract",
    wasmHash: VERIFIED_ONLY_POLICY_WASM_HASH,
    descriptor:
      "Policy contract enforcing target contracts are registered in the verified registry",
  },
};

export function validateVerifiedOnlyDefinition(def) {
  const errors = [];
  if (!def || def.type !== "verified_only") {
    errors.push("type must be verified_only");
  }
  const registryAddress = def?.verifiedOnly?.registryAddress;
  if (!registryAddress || !/^C[A-Z2-7]{55}$/.test(registryAddress)) {
    errors.push("registryAddress must be a valid Stellar contract address (C…)");
  }
  const mode = def?.verifiedOnly?.enforcementMode ?? "strict";
  if (!["strict", "trusted_publishers"].includes(mode)) {
    errors.push("enforcementMode must be strict or trusted_publishers");
  }
  return { valid: errors.length === 0, errors };
}

export function generateVerifiedOnlyPolicy(def, network = "testnet") {
  const validation = validateVerifiedOnlyDefinition(def);
  if (!validation.valid) {
    throw new Error(`Invalid policy definition: ${validation.errors.join(", ")}`);
  }
  return {
    definition: def,
    policyHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    manifest: {
      template: "verified_only",
      enforcement: {
        kind: "policy-contract",
        wasmHash: VERIFIED_ONLY_POLICY_WASM_HASH,
        descriptor: VERIFIED_ONLY_TEMPLATE.enforcement.descriptor,
        constructorArgs: {
          registryAddress: def.verifiedOnly.registryAddress,
          enforcementMode: def.verifiedOnly.enforcementMode ?? "strict",
        },
      },
      network,
    },
  };
}

export function handleRequest(req) {
  if (req.method === "GET") {
    return { status: 200, body: { template: VERIFIED_ONLY_TEMPLATE } };
  }
  if (req.method === "POST") {
    const { valid, errors } = validateVerifiedOnlyDefinition(req.body);
    if (!valid) {
      return { status: 422, body: { errors } };
    }
    const policy = generateVerifiedOnlyPolicy(req.body);
    return { status: 201, body: { policy } };
  }
  return { status: 405, body: { error: "method_not_allowed" } };
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
      const { status, body: resBody } = handleRequest({ method: req.method, body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  const port = process.env.PORT || 4007;
  server.listen(port, () => console.log(`verified-only policy route mock on port ${port}`));
}
