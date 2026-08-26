import assert from "node:assert/strict";
import { SessionBudgetTracker, handleBudgetRequest } from "./route.mjs";

// Initialize tracker with default budget of 1000
const tracker = new SessionBudgetTracker(1000);

// Test 1: Initial budget state
const initialStatus = tracker.getBudgetStatus();
assert.equal(initialStatus.total, 1000, "Initial total budget should be 1000");
assert.equal(initialStatus.spent, 0, "Initial spent should be 0");
assert.equal(initialStatus.remaining, 1000, "Initial remaining should be 1000");

// Test 2: First spend within budget
const spend1 = tracker.spend(200);
assert.equal(spend1.success, true, "First spend should succeed");
assert.equal(spend1.spent, 200, "Spent amount should be 200");
assert.equal(spend1.remaining, 800, "Remaining should be 800");

// Test 3: Second spend within budget
const spend2 = tracker.spend(300);
assert.equal(spend2.success, true, "Second spend should succeed");
assert.equal(spend2.spent, 300, "Spent amount should be 300");
assert.equal(spend2.remaining, 500, "Remaining should be 500");

// Test 4: Third spend within budget
const spend3 = tracker.spend(150);
assert.equal(spend3.success, true, "Third spend should succeed");
assert.equal(spend3.spent, 150, "Spent amount should be 150");
assert.equal(spend3.remaining, 350, "Remaining should be 350");

// Test 5: Check budget status reflects accumulated spends
const midStatus = tracker.getBudgetStatus();
assert.equal(midStatus.spent, 650, "Total spent should be 650");
assert.equal(midStatus.remaining, 350, "Remaining should be 350");
assert.equal(midStatus.total, 1000, "Total budget should remain 1000");

// Test 6: Attempt spend that would exceed budget (should be rejected)
const overBudgetSpend = tracker.spend(400);
assert.equal(overBudgetSpend.success, false, "Over-budget spend should fail");
assert.equal(overBudgetSpend.error, "insufficient_budget", "Error should be insufficient_budget");
assert.ok(
  overBudgetSpend.message.includes("400") && overBudgetSpend.message.includes("350"),
  "Error message should mention requested and remaining amounts"
);
assert.equal(overBudgetSpend.remaining, 350, "Remaining should still be 350");

// Test 7: Verify budget unchanged after rejected spend
const afterRejection = tracker.getBudgetStatus();
assert.equal(afterRejection.spent, 650, "Spent should still be 650 after rejection");
assert.equal(afterRejection.remaining, 350, "Remaining should still be 350 after rejection");

// Test 8: Spend exactly the remaining budget
const exactSpend = tracker.spend(350);
assert.equal(exactSpend.success, true, "Exact remaining spend should succeed");
assert.equal(exactSpend.remaining, 0, "Remaining should be 0");

// Test 9: Attempt spend when budget exhausted
const exhaustedSpend = tracker.spend(1);
assert.equal(exhaustedSpend.success, false, "Spend on exhausted budget should fail");
assert.equal(exhaustedSpend.remaining, 0, "Remaining should be 0");

// Test 10: Test invalid amounts
const invalidSpend1 = tracker.spend(-50);
assert.equal(invalidSpend1.success, false, "Negative amount should fail");
assert.equal(invalidSpend1.error, "invalid_amount", "Error should be invalid_amount");

const invalidSpend2 = tracker.spend(0);
assert.equal(invalidSpend2.success, false, "Zero amount should fail");
assert.equal(invalidSpend2.error, "invalid_amount", "Error should be invalid_amount");

// Test 11: Test request handler with spend action
tracker.reset(1000); // Reset for handler tests
const spendRequest = handleBudgetRequest("spend", { amount: 250 }, tracker);
assert.equal(spendRequest.status, 200, "Spend request should return 200");
assert.equal(spendRequest.body.success, true, "Spend should succeed");
assert.equal(spendRequest.body.spent, 250, "Spent amount should be 250");

// Test 12: Test request handler with remaining-budget action
const budgetRequest = handleBudgetRequest("remaining-budget", {}, tracker);
assert.equal(budgetRequest.status, 200, "Budget request should return 200");
assert.equal(budgetRequest.body.remaining, 750, "Remaining should be 750");
assert.equal(budgetRequest.body.spent, 250, "Spent should be 250");

// Test 13: Test request handler with over-budget spend
const overBudgetRequest = handleBudgetRequest("spend", { amount: 800 }, tracker);
assert.equal(overBudgetRequest.status, 400, "Over-budget request should return 400");
assert.equal(overBudgetRequest.body.success, false, "Over-budget spend should fail");
assert.equal(overBudgetRequest.body.error, "insufficient_budget", "Should have insufficient_budget error");

// Test 14: Verify budget unchanged after handler rejection
const afterHandlerRejection = handleBudgetRequest("remaining-budget", {}, tracker);
assert.equal(afterHandlerRejection.body.spent, 250, "Spent should still be 250");
assert.equal(afterHandlerRejection.body.remaining, 750, "Remaining should still be 750");

// Test 15: Test missing amount in request
const missingAmountRequest = handleBudgetRequest("spend", {}, tracker);
assert.equal(missingAmountRequest.status, 400, "Missing amount should return 400");
assert.equal(missingAmountRequest.body.error, "missing_amount", "Should have missing_amount error");

// Test 16: Test unknown action
const unknownRequest = handleBudgetRequest("unknown", {}, tracker);
assert.equal(unknownRequest.status, 400, "Unknown action should return 400");
assert.equal(unknownRequest.body.error, "unknown_action", "Should have unknown_action error");

// Test 17: Test reset functionality
const resetRequest = handleBudgetRequest("reset", { budget: 2000 }, tracker);
assert.equal(resetRequest.status, 200, "Reset should return 200");
assert.equal(resetRequest.body.total, 2000, "Total should be 2000 after reset");
assert.equal(resetRequest.body.spent, 0, "Spent should be 0 after reset");
assert.equal(resetRequest.body.remaining, 2000, "Remaining should be 2000 after reset");

// Test 18: Comprehensive scenario - multiple spends within and one over budget
tracker.reset(1000);
const scenario = [
  { amount: 100, shouldSucceed: true, expectedRemaining: 900 },
  { amount: 250, shouldSucceed: true, expectedRemaining: 650 },
  { amount: 300, shouldSucceed: true, expectedRemaining: 350 },
  { amount: 500, shouldSucceed: false, expectedRemaining: 350 }, // Over budget
  { amount: 200, shouldSucceed: true, expectedRemaining: 150 },
  { amount: 200, shouldSucceed: false, expectedRemaining: 150 }, // Over budget
  { amount: 150, shouldSucceed: true, expectedRemaining: 0 }, // Exact remaining
];

for (const [index, test] of scenario.entries()) {
  const result = tracker.spend(test.amount);
  assert.equal(
    result.success,
    test.shouldSucceed,
    `Scenario step ${index + 1}: spend ${test.amount} should ${test.shouldSucceed ? "succeed" : "fail"}`
  );
  assert.equal(
    result.remaining,
    test.expectedRemaining,
    `Scenario step ${index + 1}: remaining should be ${test.expectedRemaining}`
  );
}

// Final verification
const finalStatus = tracker.getBudgetStatus();
assert.equal(finalStatus.spent, 1000, "Final spent should be 1000");
assert.equal(finalStatus.remaining, 0, "Final remaining should be 0");

console.log("PASS: All session budget enforcement tests passed cleanly!");
console.log(`  ✓ ${18} test groups passed`);
console.log(`  ✓ Initial budget checks`);
console.log(`  ✓ Multiple within-budget spends`);
console.log(`  ✓ Over-budget rejection without state change`);
console.log(`  ✓ Request handler integration`);
console.log(`  ✓ Edge cases (exhausted budget, invalid amounts)`);
console.log(`  ✓ Comprehensive multi-step scenario`);
