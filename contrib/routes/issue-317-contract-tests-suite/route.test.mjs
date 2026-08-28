import assert from "node:assert/strict";
import { ContractVerifier, handleRequest } from "./route.mjs";

const CONTRACT_ID = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

// Test 1: Consumer request contract validation
const validGetPayload = { contractId: CONTRACT_ID };
const validGetCheck = ContractVerifier.validateConsumerRequest(
  "getVerificationStatus",
  validGetPayload,
);
assert.equal(validGetCheck.valid, true);

const invalidGetCheck = ContractVerifier.validateConsumerRequest("getVerificationStatus", {});
assert.equal(invalidGetCheck.valid, false);
assert.ok(invalidGetCheck.error.includes("Missing required field"));

// Test 2: Submit contract payload validation
const validSubmitPayload = {
  contractId: CONTRACT_ID,
  sourceType: "repo",
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.94.0",
};
const submitCheck = ContractVerifier.validateConsumerRequest(
  "submitVerification",
  validSubmitPayload,
);
assert.equal(submitCheck.valid, true);

// Test 3: Provider response schema validation
const providerGetRes = handleRequest("getVerificationStatus", validGetPayload);
assert.equal(providerGetRes.status, 200);
const providerGetCheck = ContractVerifier.validateProviderResponse(
  "getVerificationStatus",
  providerGetRes.body,
);
assert.equal(providerGetCheck.valid, true);

const providerSubmitRes = handleRequest("submitVerification", validSubmitPayload);
assert.equal(providerSubmitRes.status, 201);
const providerSubmitCheck = ContractVerifier.validateProviderResponse(
  "submitVerification",
  providerSubmitRes.body,
);
assert.equal(providerSubmitCheck.valid, true);

console.log("PASS: Issue 317 api-gateway & verification-service contract tests passed cleanly!");
