/**
 * Test suite for merge eligibility checker
 * Validates that reason codes match expected results for sample accounts
 */

import { checkMergeEligibility } from "./checker";
import { eligibleAccount, ineligibleAccount } from "./sample-accounts";
import { REASON_CODES } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function runTests(): void {
  console.log("🧪 Running merge eligibility tests...\n");

  // Test 1: Eligible account
  console.log("Test 1: Eligible Account");
  const eligibleResult = checkMergeEligibility(eligibleAccount);
  assert(eligibleResult.eligible === true, "Eligible account should have eligible=true");
  assert(eligibleResult.reasons.length === 0, "Eligible account should have no reasons");
  console.log();

  // Test 2: Ineligible account has expected reason codes
  console.log("Test 2: Ineligible Account");
  const ineligibleResult = checkMergeEligibility(ineligibleAccount);
  assert(ineligibleResult.eligible === false, "Ineligible account should have eligible=false");
  assert(ineligibleResult.reasons.length === 3, "Ineligible account should have 3 reason codes");

  // Test 3: Verify specific reason codes
  console.log("\nTest 3: Reason Code Validation");
  assert(
    ineligibleResult.reasons.includes(REASON_CODES.OPEN_TRUSTLINES),
    `Should include ${REASON_CODES.OPEN_TRUSTLINES} reason`,
  );
  assert(
    ineligibleResult.reasons.includes(REASON_CODES.PENDING_OFFERS),
    `Should include ${REASON_CODES.PENDING_OFFERS} reason`,
  );
  assert(
    ineligibleResult.reasons.includes(REASON_CODES.ESCROW_ENTRIES),
    `Should include ${REASON_CODES.ESCROW_ENTRIES} reason`,
  );

  // Test 4: Reason codes order is deterministic
  console.log("\nTest 4: Consistent Results");
  const secondCheck = checkMergeEligibility(ineligibleAccount);
  assert(
    JSON.stringify(ineligibleResult.reasons) === JSON.stringify(secondCheck.reasons),
    "Same account should produce identical results",
  );

  console.log("\n✅ All tests passed!\n");
  console.log("Results Summary:");
  console.log(`  Eligible Account (${eligibleAccount.id}):`);
  console.log(`    - Eligible: ${eligibleResult.eligible}`);
  console.log(`    - Reasons: ${eligibleResult.reasons.join(", ") || "None"}`);
  console.log();
  console.log(`  Ineligible Account (${ineligibleAccount.id}):`);
  console.log(`    - Eligible: ${ineligibleResult.eligible}`);
  console.log(`    - Reasons: ${ineligibleResult.reasons.join(", ")}`);
}

runTests();
