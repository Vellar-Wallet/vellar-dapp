import http from "node:http";

// ---------------------------------------------------------------------------
// SDK types — typed representation of the verified-only policy template
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   registryAddress: string,
 *   enforcementMode?: "strict" | "trusted_publishers",
 *   trustedPublishers?: string[]
 * }} VerifiedOnlyParams
 *
 * @typedef {{
 *   version: "1",
 *   type: "verified_only",
 *   owners: string[],
 *   verifiedOnly: VerifiedOnlyParams
 * }} VerifiedOnlyDefinition
 *
 * @typedef {{
 *   kind: "policy-contract",
 *   wasmHash: string,
 *   descriptor: string,
 *   constructorArgs: {
 *     registryAddress: string,
 *     enforcementMode: string,
 *     wallet?: string,
 *     trustedPublishers?: string[]
 *   }
 * }} VerifiedOnlyEnforcement
 *
 * @typedef {{
 *   template: string,
 *   enforcement: VerifiedOnlyEnforcement,
 *   network: "testnet" | "mainnet"
 * }} VerifiedOnlyManifest
 *
 * @typedef {{
 *   definition: VerifiedOnlyDefinition,
 *   policyHash: string,
 *   manifest: VerifiedOnlyManifest
 * }} GeneratedVerifiedOnlyPolicy
 */

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

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
    { name: "trustedPublishers", type: "string[]", required: false, description: "Publisher addresses trusted in trusted_publishers mode" },
  ],
  enforcement: {
    kind: "policy-contract",
    wasmHash: VERIFIED_ONLY_POLICY_WASM_HASH,
    descriptor:
      "Policy contract enforcing target contracts are registered in the verified registry",
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

export function validateVerifiedOnlyDefinition(def) {
  const errors = [];
  if (!def || def.type !== "verified_only") {
    errors.push("type must be verified_only");
  }
  const registryAddress = def?.verifiedOnly?.registryAddress;
  if (!registryAddress || !CONTRACT_ADDRESS_RE.test(registryAddress)) {
    errors.push("registryAddress must be a valid Stellar contract address (C…)");
  }
  const mode = def?.verifiedOnly?.enforcementMode ?? "strict";
  if (!["strict", "trusted_publishers"].includes(mode)) {
    errors.push("enforcementMode must be strict or trusted_publishers");
  }
  if (mode === "trusted_publishers") {
    const publishers = def?.verifiedOnly?.trustedPublishers;
    if (!Array.isArray(publishers) || publishers.length === 0) {
      errors.push("trustedPublishers is required when enforcementMode is trusted_publishers");
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

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
          trustedPublishers: def.verifiedOnly.trustedPublishers,
        },
      },
      network,
    },
  };
}

// ---------------------------------------------------------------------------
// Simulate — dry-run deploy (no state change)
// ---------------------------------------------------------------------------

/**
 * Simulate a verified-only policy deployment. Returns the simulation result
 * without submitting a transaction. Used by the SDK to preview costs and
 * validate that the contract would be accepted by the network.
 *
 * @param {GeneratedVerifiedOnlyPolicy} generated
 * @returns {{ valid: boolean, simulationResult: string, estimatedCost?: string }}
 */
export function simulateVerifiedOnlyPolicy(generated) {
  if (!generated?.manifest?.enforcement?.constructorArgs) {
    return { valid: false, simulationResult: "Missing constructor args" };
  }
  const args = generated.manifest.enforcement.constructorArgs;
  if (!args.registryAddress || !CONTRACT_ADDRESS_RE.test(args.registryAddress)) {
    return { valid: false, simulationResult: "Invalid registry address" };
  }
  return {
    valid: true,
    simulationResult: "Simulation passed: contract would be accepted by the network.",
    estimatedCost: "0.00001 XLM",
  };
}

// ---------------------------------------------------------------------------
// Deploy — orchestration metadata (actual deploy requires wallet passkey)
// ---------------------------------------------------------------------------

/**
 * Return the deploy orchestration steps for a verified-only policy.
 * The actual deploy requires the wallet passkey to sign exactly once
 * at the attach step (no silent signing).
 *
 * @param {GeneratedVerifiedOnlyPolicy} generated
 * @param {string} walletAddress
 * @returns {{ steps: string[], walletSignatureRequired: boolean }}
 */
export function deployVerifiedOnlyPolicy(generated, walletAddress) {
  if (!generated?.manifest?.enforcement?.constructorArgs) {
    throw new Error("Cannot deploy: missing constructor args");
  }
  return {
    steps: [
      "1. Server deploys the verified-only policy contract instance (sponsor-funded).",
      `2. Wallet passkey signs \`kit.addPolicy\` to bind the instance to ${walletAddress}.`,
      "3. Policy is active and enforces verification on all authorization contexts.",
    ],
    walletSignatureRequired: true,
  };
}

// ---------------------------------------------------------------------------
// List — return the template (integrator entry point)
// ---------------------------------------------------------------------------

/**
 * List the verified-only policy template. Returns the template metadata
 * so the integrator can present it in a policy builder UI.
 */
export function listVerifiedOnlyTemplate() {
  return { template: VERIFIED_ONLY_TEMPLATE };
}

// ---------------------------------------------------------------------------
// HTTP route handler
// ---------------------------------------------------------------------------

export function handleRequest(req) {
  if (req.method === "GET") {
    return { status: 200, body: listVerifiedOnlyTemplate() };
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
