import assert from "node:assert/strict";
import { SafetyPolicyE2ESimulator, handleLifecycleRequest } from "./route.mjs";

const sim = new SafetyPolicyE2ESimulator();

// 1. Configure safety policy
const configured = sim.configurePolicy("50");
assert.equal(configured.dailyXlm, "50");
assert.equal(configured.status, "generated");

// 2. Deploy policy to account
const wallet = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const deployed = sim.deployPolicy(wallet);
assert.equal(deployed.status, "attached");
assert.ok(deployed.contractId.startsWith("C"));

// 3. Attempt valid transaction within limit
const validResult = sim.attemptTransaction("30", "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM");
assert.equal(validResult.allowed, true);

// 4. Attempt violating transaction over limit
const invalidResult = sim.attemptTransaction("100", "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM");
assert.equal(invalidResult.allowed, false);
assert.ok(invalidResult.explanation.includes("violates configured safety policy spending limit"));

// 5. Review user-facing strings for honest positioning (no universal protection, intent firewall, or fiat amounts)
const sampleStrings = [
  "Configures on-chain spending controls for known transfer patterns.",
  "Enforces rolling daily limits on XLM transfers.",
  "Policy attached to smart account.",
];

const wordingReview = sim.reviewPositioningWording(sampleStrings);
assert.equal(wordingReview.passed, true);
assert.equal(wordingReview.issues.length, 0);

// Test prohibited term detection
const badStrings = [
  "This is a universal protection intent firewall.",
  "Limits daily spending to $500 USD.",
];
const badReview = sim.reviewPositioningWording(badStrings);
assert.equal(badReview.passed, false);
assert.ok(badReview.issues.length >= 2);

// Test full flow handler
const fullFlow = handleLifecycleRequest("full_flow", { dailyXlm: "50" });
assert.equal(fullFlow.status, 200);
assert.equal(fullFlow.body.invalidTx.allowed, false);

console.log("PASS: Issue 24 safety e2e lifecycle and positioning review tests passed cleanly!");
