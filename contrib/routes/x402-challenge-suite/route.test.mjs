import assert from "node:assert/strict";
import { PaymentChallenge, handleProtectedRequest } from "./route.mjs";

const challengeService = new PaymentChallenge();

// Test 1: Initial request without payment proof returns 402
const initialRequest = handleProtectedRequest(null, challengeService);
assert.equal(initialRequest.status, 402, "Should return 402 without payment proof");
assert.ok(initialRequest.body.error, "Should include error in response");
assert.ok(initialRequest.body.challenge, "Should include payment challenge");
assert.ok(
  initialRequest.body.challenge.challenge_token,
  "Challenge should include token"
);
assert.ok(initialRequest.body.challenge.amount, "Challenge should include amount");

// Test 2: Challenge includes required fields
const challenge1 = initialRequest.body.challenge;
assert.ok(challenge1.challenge_token, "Challenge should have token");
assert.equal(typeof challenge1.amount, "number", "Amount should be a number");
assert.ok(challenge1.timestamp, "Challenge should have timestamp");
assert.ok(challenge1.expires_at, "Challenge should have expiration");
assert.equal(challenge1.currency, "XLM", "Currency should be XLM");

// Test 3: Generate valid proof from challenge
const validProof = challengeService.generateValidProof(
  challenge1.challenge_token,
  challenge1.amount
);
assert.ok(validProof, "Should generate valid proof");
assert.equal(typeof validProof, "string", "Proof should be a string");
assert.ok(validProof.length > 0, "Proof should not be empty");

// Test 4: Verify valid proof succeeds
const isValidProof = challengeService.verifyProof(
  validProof,
  challenge1.challenge_token,
  challenge1.amount
);
assert.equal(isValidProof, true, "Valid proof should be verified");

// Test 5: Verify invalid proof fails
const invalidProof = "invalid_proof_string";
const isInvalidProof = challengeService.verifyProof(
  invalidProof,
  challenge1.challenge_token,
  challenge1.amount
);
assert.equal(isInvalidProof, false, "Invalid proof should fail verification");

// Test 6: Request with invalid proof returns 402
const invalidRequest = handleProtectedRequest(invalidProof, challengeService);
assert.equal(invalidRequest.status, 402, "Should return 402 with invalid proof");
assert.equal(
  invalidRequest.body.error,
  "invalid_payment_proof",
  "Should indicate invalid proof"
);
assert.ok(
  invalidRequest.body.challenge,
  "Should include new challenge after invalid proof"
);

// Test 7: Request with valid proof returns 200 and protected content
const proofHeader = `${challenge1.challenge_token}:${validProof}`;
const successRequest = handleProtectedRequest(proofHeader, challengeService);
assert.equal(successRequest.status, 200, "Should return 200 with valid proof");
assert.ok(successRequest.body.message, "Should include protected content");
assert.ok(successRequest.body.data, "Should include protected data");
assert.equal(
  successRequest.headers["X-Payment-Verified"],
  "true",
  "Should include verification header"
);

// Test 8: Protected content structure
assert.ok(
  successRequest.body.message.includes("protected"),
  "Message should reference protected content"
);
assert.ok(successRequest.body.data.premium_feature, "Should include premium features");
assert.ok(successRequest.body.data.access_level, "Should include access level");

// Test 9: Challenge token is consumed after successful use
const reusedProofRequest = handleProtectedRequest(proofHeader, challengeService);
assert.equal(
  reusedProofRequest.status,
  402,
  "Should reject reused proof/token"
);

// Test 10: Generate new challenge for fresh attempt
const challenge2Request = handleProtectedRequest(null, challengeService);
assert.equal(challenge2Request.status, 402);
const challenge2 = challenge2Request.body.challenge;
assert.notEqual(
  challenge2.challenge_token,
  challenge1.challenge_token,
  "New challenge should have different token"
);

// Test 11: Proof from one challenge doesn't work with another
const proof2 = challengeService.generateValidProof(
  challenge2.challenge_token,
  challenge2.amount
);
const wrongChallengeProof = `${challenge1.challenge_token}:${proof2}`;
const wrongChallengeRequest = handleProtectedRequest(
  wrongChallengeProof,
  challengeService
);
assert.equal(
  wrongChallengeRequest.status,
  402,
  "Should reject proof with wrong challenge token"
);

// Test 12: Proof without token prefix (searches active challenges)
const proof3Request = handleProtectedRequest(null, challengeService);
const challenge3 = proof3Request.body.challenge;
const proof3 = challengeService.generateValidProof(
  challenge3.challenge_token,
  challenge3.amount
);
const proofOnlyRequest = handleProtectedRequest(proof3, challengeService);
assert.equal(
  proofOnlyRequest.status,
  200,
  "Should accept proof without token prefix if it matches an active challenge"
);

// Test 13: Empty proof header returns 402
const emptyProofRequest = handleProtectedRequest("", challengeService);
assert.equal(emptyProofRequest.status, 402, "Should reject empty proof");

// Test 14: Malformed proof header returns 402
const malformedProofRequest = handleProtectedRequest(
  ":::malformed:::",
  challengeService
);
assert.equal(malformedProofRequest.status, 402, "Should reject malformed proof");

// Test 15: Comprehensive flow - initial challenge, failed retry, successful retry
const flowChallenge = handleProtectedRequest(null, challengeService);
assert.equal(flowChallenge.status, 402, "Step 1: Initial request should return 402");

const flowChallengeData = flowChallenge.body.challenge;
const flowInvalidProof = "definitely_invalid";
const flowFailedRetry = handleProtectedRequest(
  flowInvalidProof,
  challengeService
);
assert.equal(
  flowFailedRetry.status,
  402,
  "Step 2: Failed retry should return 402"
);

const flowValidProof = challengeService.generateValidProof(
  flowChallengeData.challenge_token,
  flowChallengeData.amount
);
const flowSuccessRetry = handleProtectedRequest(
  `${flowChallengeData.challenge_token}:${flowValidProof}`,
  challengeService
);
assert.equal(
  flowSuccessRetry.status,
  200,
  "Step 3: Successful retry should return 200"
);
assert.ok(
  flowSuccessRetry.body.message,
  "Step 3: Should include protected content"
);

// Test 16: Parse proof header formats
const parsed1 = challengeService.parseProof("token123:proof456");
assert.equal(parsed1.token, "token123", "Should parse token from header");
assert.equal(parsed1.proof, "proof456", "Should parse proof from header");

const parsed2 = challengeService.parseProof("justproof");
assert.equal(parsed2.token, null, "Should handle proof without token");
assert.equal(parsed2.proof, "justproof", "Should extract proof");

const parsed3 = challengeService.parseProof(null);
assert.equal(parsed3, null, "Should handle null proof");

// Test 17: Validate proof header with missing proof
const validation1 = challengeService.validateProofHeader(null);
assert.equal(validation1.valid, false, "Should reject null proof");
assert.equal(validation1.reason, "missing_proof");

// Test 18: Validate proof header with nonexistent challenge token
const validation2 = challengeService.validateProofHeader(
  "nonexistent:someproof"
);
assert.equal(validation2.valid, false, "Should reject nonexistent token");
assert.equal(validation2.reason, "invalid_challenge_token");

// Test 19: Multiple concurrent challenges
const concurrentChallenge1 = challengeService.generateChallenge();
const concurrentChallenge2 = challengeService.generateChallenge();
const concurrentChallenge3 = challengeService.generateChallenge();

assert.notEqual(
  concurrentChallenge1.challenge_token,
  concurrentChallenge2.challenge_token,
  "Concurrent challenges should have unique tokens"
);
assert.notEqual(
  concurrentChallenge2.challenge_token,
  concurrentChallenge3.challenge_token,
  "Concurrent challenges should have unique tokens"
);

// Verify all three can be validated independently
const concurrentProof1 = challengeService.generateValidProof(
  concurrentChallenge1.challenge_token,
  concurrentChallenge1.amount
);
const concurrentProof2 = challengeService.generateValidProof(
  concurrentChallenge2.challenge_token,
  concurrentChallenge2.amount
);

const concurrentValidation1 = challengeService.validateProofHeader(
  `${concurrentChallenge1.challenge_token}:${concurrentProof1}`
);
const concurrentValidation2 = challengeService.validateProofHeader(
  `${concurrentChallenge2.challenge_token}:${concurrentProof2}`
);

assert.equal(concurrentValidation1.valid, true, "First concurrent proof should validate");
assert.equal(concurrentValidation2.valid, true, "Second concurrent proof should validate");

// Test 20: Full scenario with request handler
console.log("Running full x402 flow scenario...");

// Step 1: Initial access without payment
const scenario1 = handleProtectedRequest(null, challengeService);
assert.equal(scenario1.status, 402, "Scenario step 1: Should challenge for payment");

// Step 2: Failed retry with wrong proof
const scenario2 = handleProtectedRequest("wrong_proof", challengeService);
assert.equal(scenario2.status, 402, "Scenario step 2: Should reject wrong proof");

// Step 3: Failed retry with empty proof
const scenario3 = handleProtectedRequest("", challengeService);
assert.equal(scenario3.status, 402, "Scenario step 3: Should reject empty proof");

// Step 4: Successful retry with valid proof
const scenarioChallenge = scenario1.body.challenge;
const scenarioProof = challengeService.generateValidProof(
  scenarioChallenge.challenge_token,
  scenarioChallenge.amount
);
const scenario4 = handleProtectedRequest(
  `${scenarioChallenge.challenge_token}:${scenarioProof}`,
  challengeService
);
assert.equal(scenario4.status, 200, "Scenario step 4: Should grant access with valid proof");
assert.ok(scenario4.body.data, "Scenario step 4: Should return protected data");

console.log("PASS: All x402 payment challenge tests passed cleanly!");
console.log(`  ✓ ${20} test groups passed`);
console.log(`  ✓ Initial request returns 402 with challenge`);
console.log(`  ✓ Invalid proof returns 402 with new challenge`);
console.log(`  ✓ Valid proof returns 200 with protected content`);
console.log(`  ✓ Challenge token consumed after successful use`);
console.log(`  ✓ Comprehensive flow: challenge → failed retry → successful retry`);
console.log(`  ✓ Edge cases (empty proof, malformed proof, reused proof)`);
console.log(`  ✓ Multiple concurrent challenges`);
