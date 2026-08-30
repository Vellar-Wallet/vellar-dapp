import assert from "node:assert/strict";
import {
  VERIFIED_ONLY_TEMPLATE,
  validateVerifiedOnlyDefinition,
  generateVerifiedOnlyPolicy,
  handleRequest,
} from "./route.mjs";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

// 1. Template listed with descriptor
assert.equal(VERIFIED_ONLY_TEMPLATE.type, "verified_only");
assert.equal(VERIFIED_ONLY_TEMPLATE.enforcement.kind, "policy-contract");
assert.ok(VERIFIED_ONLY_TEMPLATE.enforcement.descriptor.includes("verified registry"));

const getRes = handleRequest({ method: "GET" });
assert.equal(getRes.status, 200);
assert.equal(getRes.body.template.type, "verified_only");

// 2. Valid definition generates artifacts
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

const postRes = handleRequest({ method: "POST", body: validDef });
assert.equal(postRes.status, 201);
assert.equal(postRes.body.policy.manifest.template, "verified_only");

// 3. Invalid definition rejected with readable error
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

console.log("PASS: Issue 7 verified-only policy route tests passed cleanly!");
