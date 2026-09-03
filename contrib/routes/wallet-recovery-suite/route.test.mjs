import assert from "node:assert/strict";
import { createState, handleRequest } from "./route.mjs";

function call(state, path, body) {
  return handleRequest(state, "POST", path, body);
}

const state = createState();
const first = call(state, "/request-recovery", {
  accountId: "account_001",
  fallbackSigner: "fallback_001",
});
assert.equal(first.status, 201);
assert.deepEqual(first.body, {
  recoveryRequestId: "recovery_001",
  status: "pending_verification",
  verificationToken: "verify_recovery_001",
});

// A new signer cannot be issued while the request is unverified.
const unverified = call(state, "/issue-new-signer", {
  recoveryRequestId: "recovery_001",
  signer: "signer_001",
});
assert.equal(unverified.status, 403);
assert.equal(unverified.body.error, "recovery_not_verified");

const second = call(state, "/request-recovery", {
  accountId: "account_002",
  fallbackSigner: "fallback_002",
});
assert.equal(second.body.recoveryRequestId, "recovery_002");

// Verifying another request must not authorize the first request.
const verifiedSecond = call(state, "/verify-fallback", {
  recoveryRequestId: "recovery_002",
  verificationToken: "verify_recovery_002",
});
assert.equal(verifiedSecond.status, 200);
assert.equal(call(state, "/issue-new-signer", {
  recoveryRequestId: "recovery_001",
  signer: "signer_001",
}).status, 403);

// A token from a different request cannot verify this request.
const wrongToken = call(state, "/verify-fallback", {
  recoveryRequestId: "recovery_001",
  verificationToken: "verify_recovery_002",
});
assert.equal(wrongToken.status, 401);
assert.equal(wrongToken.body.error, "invalid_fallback_verification");

const verifiedFirst = call(state, "/verify-fallback", {
  recoveryRequestId: "recovery_001",
  verificationToken: "verify_recovery_001",
});
assert.equal(verifiedFirst.status, 200);
assert.equal(verifiedFirst.body.verified, true);

const issued = call(state, "/issue-new-signer", {
  recoveryRequestId: "recovery_001",
  signer: "signer_001",
});
assert.equal(issued.status, 201);
assert.deepEqual(issued.body, {
  recoveryRequestId: "recovery_001",
  accountId: "account_001",
  signer: "signer_001",
  issued: true,
});
assert.equal(call(state, "/issue-new-signer", {
  recoveryRequestId: "recovery_001",
  signer: "signer_001",
}).status, 409);

assert.equal(call(state, "/issue-new-signer", {
  recoveryRequestId: "recovery_missing",
  signer: "signer_999",
}).status, 404);
assert.equal(handleRequest(state, "GET", "/request-recovery").status, 405);
assert.equal(handleRequest(state, "POST", "/unknown", {}).status, 404);

console.log("PASS: wallet-recovery suite — request, exact fallback verification, and signer issuance");
