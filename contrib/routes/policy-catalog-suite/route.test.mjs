import assert from "node:assert/strict";
import { PolicyCatalog, handleRequest } from "./route.mjs";

const catalog = new PolicyCatalog();

// Test 1: List all policy types
const types = catalog.listTypes();
assert.ok(Array.isArray(types.types), "Should return types array");
assert.equal(types.types.length, 4, "Should have 4 policy types");
assert.ok(
  types.types.some((t) => t.id === "spending_limit"),
  "Should include spending_limit type"
);
assert.ok(
  types.types.some((t) => t.id === "transfer_whitelist"),
  "Should include transfer_whitelist type"
);
assert.ok(
  types.types.some((t) => t.id === "time_lock"),
  "Should include time_lock type"
);
assert.ok(
  types.types.some((t) => t.id === "multi_sig"),
  "Should include multi_sig type"
);

// Test 2: Get rules for spending_limit policy
const spendingRules = catalog.getRules("spending_limit");
assert.equal(spendingRules.policyType, "spending_limit");
assert.ok(Array.isArray(spendingRules.rules), "Should return rules array");
assert.ok(
  spendingRules.rules.length >= 2,
  "Should have at least 2 validation rules"
);
assert.ok(
  spendingRules.rules.some((r) => r.id === "minimum_amount"),
  "Should have minimum_amount rule"
);
assert.ok(
  spendingRules.rules.some((r) => r.id === "maximum_amount"),
  "Should have maximum_amount rule"
);

// Test 3: Get rules for transfer_whitelist policy
const whitelistRules = catalog.getRules("transfer_whitelist");
assert.equal(whitelistRules.policyType, "transfer_whitelist");
assert.ok(
  whitelistRules.rules.length >= 2,
  "Should have at least 2 validation rules"
);

// Test 4: Get rules for time_lock policy
const timeLockRules = catalog.getRules("time_lock");
assert.equal(timeLockRules.policyType, "time_lock");
assert.ok(
  timeLockRules.rules.length >= 2,
  "Should have at least 2 validation rules"
);

// Test 5: Get rules for multi_sig policy
const multiSigRules = catalog.getRules("multi_sig");
assert.equal(multiSigRules.policyType, "multi_sig");
assert.ok(
  multiSigRules.rules.length >= 2,
  "Should have at least 2 validation rules"
);

// Test 6: Validate fully passing spending_limit configuration
const validSpendingConfig = {
  dailyLimit: 100,
  txLimit: 50,
};
const validSpendingResult = catalog.validate("spending_limit", validSpendingConfig);
assert.equal(validSpendingResult.valid, true, "Valid config should pass");
assert.ok(
  validSpendingResult.results.every((r) => r.passed),
  "All rules should pass"
);
assert.equal(
  validSpendingResult.results.length,
  3,
  "Should have 3 validation results"
);

// Test 7: Validate failing spending_limit configuration (too low)
const tooLowConfig = {
  dailyLimit: 0.5,
  txLimit: 0.5,
};
const tooLowResult = catalog.validate("spending_limit", tooLowConfig);
assert.equal(tooLowResult.valid, false, "Too low config should fail");
assert.ok(
  tooLowResult.results.some((r) => !r.passed && r.ruleId === "minimum_amount"),
  "Should fail minimum_amount rule"
);

// Test 8: Validate failing spending_limit configuration (too high)
const tooHighConfig = {
  dailyLimit: 2000000,
  txLimit: 100,
};
const tooHighResult = catalog.validate("spending_limit", tooHighConfig);
assert.equal(tooHighResult.valid, false, "Too high config should fail");
assert.ok(
  tooHighResult.results.some((r) => !r.passed && r.ruleId === "maximum_amount"),
  "Should fail maximum_amount rule"
);

// Test 9: Validate failing spending_limit configuration (tx > daily)
const txExceedsDailyConfig = {
  dailyLimit: 50,
  txLimit: 100,
};
const txExceedsDailyResult = catalog.validate("spending_limit", txExceedsDailyConfig);
assert.equal(txExceedsDailyResult.valid, false, "Tx > daily config should fail");
assert.ok(
  txExceedsDailyResult.results.some(
    (r) => !r.passed && r.ruleId === "tx_vs_daily_limit"
  ),
  "Should fail tx_vs_daily_limit rule"
);

// Test 10: Validate passing transfer_whitelist configuration
const validWhitelistConfig = {
  recipients: [
    "GBXMB7SEH3VGA5QPMWFYVQZ76M56XTWMXRQ5MJDGXKZ6NVQ2XVMVFKFS",
    "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
  ],
};
const validWhitelistResult = catalog.validate("transfer_whitelist", validWhitelistConfig);
assert.equal(validWhitelistResult.valid, true, "Valid whitelist config should pass");
assert.ok(
  validWhitelistResult.results.every((r) => r.passed),
  "All rules should pass"
);

// Test 11: Validate failing transfer_whitelist configuration (no recipients)
const noRecipientsConfig = {
  recipients: [],
};
const noRecipientsResult = catalog.validate("transfer_whitelist", noRecipientsConfig);
assert.equal(noRecipientsResult.valid, false, "No recipients config should fail");
assert.ok(
  noRecipientsResult.results.some(
    (r) => !r.passed && r.ruleId === "minimum_recipients"
  ),
  "Should fail minimum_recipients rule"
);

// Test 12: Validate passing time_lock configuration
const validTimeLockConfig = {
  delaySeconds: 3600, // 1 hour
};
const validTimeLockResult = catalog.validate("time_lock", validTimeLockConfig);
assert.equal(validTimeLockResult.valid, true, "Valid time_lock config should pass");
assert.ok(
  validTimeLockResult.results.every((r) => r.passed),
  "All rules should pass"
);

// Test 13: Validate failing time_lock configuration (too short)
const tooShortDelayConfig = {
  delaySeconds: 30,
};
const tooShortDelayResult = catalog.validate("time_lock", tooShortDelayConfig);
assert.equal(tooShortDelayResult.valid, false, "Too short delay should fail");
assert.ok(
  tooShortDelayResult.results.some(
    (r) => !r.passed && r.ruleId === "minimum_delay"
  ),
  "Should fail minimum_delay rule"
);

// Test 14: Validate failing time_lock configuration (too long)
const tooLongDelayConfig = {
  delaySeconds: 366 * 24 * 60 * 60, // More than 365 days
};
const tooLongDelayResult = catalog.validate("time_lock", tooLongDelayConfig);
assert.equal(tooLongDelayResult.valid, false, "Too long delay should fail");
assert.ok(
  tooLongDelayResult.results.some(
    (r) => !r.passed && r.ruleId === "maximum_delay"
  ),
  "Should fail maximum_delay rule"
);

// Test 15: Validate passing multi_sig configuration
const validMultiSigConfig = {
  requiredSignatures: 3,
};
const validMultiSigResult = catalog.validate("multi_sig", validMultiSigConfig);
assert.equal(validMultiSigResult.valid, true, "Valid multi_sig config should pass");
assert.ok(
  validMultiSigResult.results.every((r) => r.passed),
  "All rules should pass"
);

// Test 16: Validate failing multi_sig configuration (too few)
const tooFewSigsConfig = {
  requiredSignatures: 1,
};
const tooFewSigsResult = catalog.validate("multi_sig", tooFewSigsConfig);
assert.equal(tooFewSigsResult.valid, false, "Too few signatures should fail");
assert.ok(
  tooFewSigsResult.results.some(
    (r) => !r.passed && r.ruleId === "minimum_signatures"
  ),
  "Should fail minimum_signatures rule"
);

// Test 17: Validate failing multi_sig configuration (too many)
const tooManySigsConfig = {
  requiredSignatures: 25,
};
const tooManySigsResult = catalog.validate("multi_sig", tooManySigsConfig);
assert.equal(tooManySigsResult.valid, false, "Too many signatures should fail");
assert.ok(
  tooManySigsResult.results.some(
    (r) => !r.passed && r.ruleId === "maximum_signatures"
  ),
  "Should fail maximum_signatures rule"
);

// Test 18: Test request handler with list-types action
const listTypesRequest = handleRequest("list-types", {});
assert.equal(listTypesRequest.status, 200);
assert.ok(Array.isArray(listTypesRequest.body.types));

// Test 19: Test request handler with get-rules action
const getRulesRequest = handleRequest("get-rules", { policyType: "spending_limit" });
assert.equal(getRulesRequest.status, 200);
assert.equal(getRulesRequest.body.policyType, "spending_limit");

// Test 20: Test request handler with validate action (passing)
const validatePassRequest = handleRequest("validate", {
  policyType: "spending_limit",
  config: { dailyLimit: 100, txLimit: 50 },
});
assert.equal(validatePassRequest.status, 200);
assert.equal(validatePassRequest.body.valid, true);

// Test 21: Test request handler with validate action (failing)
const validateFailRequest = handleRequest("validate", {
  policyType: "spending_limit",
  config: { dailyLimit: 0.5, txLimit: 0.5 },
});
assert.equal(validateFailRequest.status, 200);
assert.equal(validateFailRequest.body.valid, false);

// Test 22: Test request handler with missing policyType
const missingTypeRequest = handleRequest("get-rules", {});
assert.equal(missingTypeRequest.status, 400);
assert.ok(missingTypeRequest.body.error);

// Test 23: Test request handler with unknown action
const unknownActionRequest = handleRequest("unknown", {});
assert.equal(unknownActionRequest.status, 400);
assert.equal(unknownActionRequest.body.error, "unknown_action");

// Test 24: Test request handler with unknown policy type
const unknownPolicyRequest = handleRequest("get-rules", {
  policyType: "unknown_policy",
});
assert.equal(unknownPolicyRequest.status, 400);
assert.ok(unknownPolicyRequest.body.error);

console.log("PASS: All policy catalog validation tests passed cleanly!");
console.log(`  ✓ ${24} test groups passed`);
console.log(`  ✓ List all policy types`);
console.log(`  ✓ Get rules for each policy type`);
console.log(`  ✓ Validate passing configurations`);
console.log(`  ✓ Validate failing configurations (at least one rule fails)`);
console.log(`  ✓ Request handler integration`);
console.log(`  ✓ Error handling for missing/invalid inputs`);
