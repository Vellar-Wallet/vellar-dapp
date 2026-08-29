import assert from "node:assert/strict";
import {
  VERIFIED_ONLY_TEMPLATE,
  validateVerifiedOnlyDefinition,
  generateVerifiedOnlyPolicy,
  simulateVerifiedOnlyPolicy,
  deployVerifiedOnlyPolicy,
  listVerifiedOnlyTemplate,
  handleRequest,
} from "./route.mjs";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

// ---- 1. Template appears through the client ----

assert.equal(VERIFIED_ONLY_TEMPLATE.type, "verified_only");
assert.equal(VERIFIED_ONLY_TEMPLATE.enforcement.kind, "policy-contract");
assert.ok(VERIFIED_ONLY_TEMPLATE.enforcement.descriptor.includes("verified registry"));
assert.ok(VERIFIED_ONLY_TEMPLATE.parameters.length >= 2);

const listResult = listVerifiedOnlyTemplate();
assert.equal(listResult.template.type, "verified_only");

const getRes = handleRequest({ method: "GET" });
assert.equal(getRes.status, 200);
assert.equal(getRes.body.template.type, "verified_only");
console.log("PASS: template appears through client and list endpoint");

// ---- 2. Generate produces artifacts for it ----

const validDef = {
  version: "1",
  type: "verified_only",
  owners: [C1],
  verifiedOnly: { registryAddress: C1, enforcementMode: "strict" },
};

const validResult = validateVerifiedOnlyDefinition(validDef);
assert.equal(validResult.valid, true);

const generated = generateVerifiedOnlyPolicy(validDef);
assert.equal(generated.manifest.template, "verified_only");
assert.equal(generated.manifest.enforcement.constructorArgs.registryAddress, C1);
assert.equal(generated.manifest.enforcement.constructorArgs.enforcementMode, "strict");
assert.ok(generated.manifest.enforcement.descriptor.includes("verified registry"));
assert.ok(typeof generated.policyHash === "string");
assert.ok(generated.policyHash.length > 0);

const postRes = handleRequest({ method: "POST", body: validDef });
assert.equal(postRes.status, 201);
assert.equal(postRes.body.policy.manifest.template, "verified_only");
console.log("PASS: generate produces artifacts for verified_only template");

// ---- 3. Simulate dry-run ----

const simResult = simulateVerifiedOnlyPolicy(generated);
assert.equal(simResult.valid, true);
assert.ok(simResult.simulationResult.includes("passed"));
assert.ok(typeof simResult.estimatedCost === "string");
console.log("PASS: simulate dry-run succeeds for valid generated policy");

// ---- 4. Deploy orchestration ----

const deployResult = deployVerifiedOnlyPolicy(generated, C1);
assert.equal(deployResult.walletSignatureRequired, true);
assert.ok(Array.isArray(deployResult.steps));
assert.ok(deployResult.steps.length >= 2);
assert.ok(deployResult.steps.some((s) => s.includes("passkey")));
console.log("PASS: deploy orchestration returns correct steps");

// ---- 5. Invalid definition rejected ----

const invalidDef = {
  version: "1",
  type: "verified_only",
  owners: [C1],
  verifiedOnly: { registryAddress: G1 }, // G address is invalid for contract
};

const invalidResult = validateVerifiedOnlyDefinition(invalidDef);
assert.equal(invalidResult.valid, false);
assert.ok(invalidResult.errors.join(", ").includes("Stellar contract address"));

const invalidPostRes = handleRequest({ method: "POST", body: invalidDef });
assert.equal(invalidPostRes.status, 422);
assert.ok(invalidPostRes.body.errors.length > 0);
console.log("PASS: invalid definition rejected with readable error");

// ---- 6. Unknown method rejected ----

const methodRes = handleRequest({ method: "DELETE" });
assert.equal(methodRes.status, 405);
console.log("PASS: unknown method rejected");

// ---- 7. Trusted publishers mode ----

const trustedDef = {
  version: "1",
  type: "verified_only",
  owners: [C1],
  verifiedOnly: {
    registryAddress: C1,
    enforcementMode: "trusted_publishers",
    trustedPublishers: [C1],
  },
};

const trustedValid = validateVerifiedOnlyDefinition(trustedDef);
assert.equal(trustedValid.valid, true);

const trustedGenerated = generateVerifiedOnlyPolicy(trustedDef);
assert.equal(trustedGenerated.manifest.enforcement.constructorArgs.enforcementMode, "trusted_publishers");
assert.deepEqual(trustedGenerated.manifest.enforcement.constructorArgs.trustedPublishers, [C1]);
console.log("PASS: trusted_publishers mode validates and generates correctly");

// ---- 8. Trusted publishers mode without publishers list fails ----

const missingPublishers = {
  version: "1",
  type: "verified_only",
  owners: [C1],
  verifiedOnly: {
    registryAddress: C1,
    enforcementMode: "trusted_publishers",
  },
};

const mpResult = validateVerifiedOnlyDefinition(missingPublishers);
assert.equal(mpResult.valid, false);
assert.ok(mpResult.errors.join(", ").includes("trustedPublishers"));
console.log("PASS: trusted_publishers mode without publishers list fails validation");

// ---- 9. Generate with network override ----

const mainnetDef = {
  version: "1",
  type: "verified_only",
  owners: [C1],
  verifiedOnly: { registryAddress: C1, enforcementMode: "strict" },
};

const mainnetGenerated = generateVerifiedOnlyPolicy(mainnetDef, "mainnet");
assert.equal(mainnetGenerated.manifest.network, "mainnet");
console.log("PASS: generate with network override works");

// ---- 10. Simulate fails for missing constructor args ----

const badSimResult = simulateVerifiedOnlyPolicy({ manifest: {} });
assert.equal(badSimResult.valid, false);
console.log("PASS: simulate fails for missing constructor args");

// ---- 11. Deploy fails for missing constructor args ----

let deployThrew = false;
try {
  deployVerifiedOnlyPolicy({ manifest: {} }, C1);
} catch {
  deployThrew = true;
}
assert.equal(deployThrew, true);
console.log("PASS: deploy fails for missing constructor args");

console.log("\nAll B8 verified-only policy SDK tests passed!");
