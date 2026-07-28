/**
 * Test suite for cleanup plan generator
 * Validates that plans are generated correctly and steps are properly ordered
 */

import { getCleanupPlan, validateStepOrder } from "./planner";
import { simpleAccountId, complexAccountId } from "./sample-accounts";
import { STEP_TYPES } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function runTests(): void {
  console.log("🧪 Running cleanup plan tests...\n");

  // Test 1: Simple account plan
  console.log("Test 1: Simple Account Cleanup Plan");
  const simplePlan = getCleanupPlan(simpleAccountId);
  assert(simplePlan.accountId === simpleAccountId, "Plan should have correct account ID");
  assert(simplePlan.steps.length === 3, "Simple plan should have 3 steps");
  console.log();

  // Test 2: Complex account plan
  console.log("Test 2: Complex Account Cleanup Plan");
  const complexPlan = getCleanupPlan(complexAccountId);
  assert(complexPlan.accountId === complexAccountId, "Plan should have correct account ID");
  assert(complexPlan.steps.length === 7, "Complex plan should have 7 steps");
  console.log();

  // Test 3: Steps are ordered sequentially
  console.log("Test 3: Step Ordering");
  assert(validateStepOrder(simplePlan), "Simple plan steps should be in correct order");
  assert(validateStepOrder(complexPlan), "Complex plan steps should be in correct order");
  console.log();

  // Test 4: All steps have required fields
  console.log("Test 4: Step Structure");
  simplePlan.steps.forEach((step, index) => {
    assert(step.order === index + 1, `Step ${index + 1} should have correct order value`);
    assert(step.type !== "", `Step ${index + 1} should have a type`);
    assert(step.description !== "", `Step ${index + 1} should have a description`);
  });
  console.log();

  // Test 5: Verify step types
  console.log("Test 5: Step Types");
  assert(
    simplePlan.steps[0].type === STEP_TYPES.CLOSE_TRUSTLINE,
    "First step of simple plan should be CLOSE_TRUSTLINE",
  );
  assert(
    simplePlan.steps[1].type === STEP_TYPES.CANCEL_OFFER,
    "Second step of simple plan should be CANCEL_OFFER",
  );
  assert(simplePlan.steps[2].type === STEP_TYPES.FINALIZE, "Last step should be FINALIZE");

  assert(
    complexPlan.steps[4].type === STEP_TYPES.RELEASE_ESCROW,
    "Complex plan should have RELEASE_ESCROW step",
  );
  assert(
    complexPlan.steps[5].type === STEP_TYPES.DISABLE_CLAWBACK,
    "Complex plan should have DISABLE_CLAWBACK step",
  );
  console.log();

  // Test 6: Unknown account returns empty plan
  console.log("Test 6: Unknown Account Handling");
  const unknownPlan = getCleanupPlan("GZZZZ...");
  assert(unknownPlan.steps.length === 0, "Unknown account should return empty steps array");
  console.log();

  console.log("✅ All tests passed!\n");
  console.log("Results Summary:");
  console.log(`\n  Simple Account (${simpleAccountId}):`);
  console.log(`    - Steps: ${simplePlan.steps.length}`);
  simplePlan.steps.forEach((step) => {
    console.log(`      ${step.order}. [${step.type}] ${step.description}`);
  });

  console.log(`\n  Complex Account (${complexAccountId}):`);
  console.log(`    - Steps: ${complexPlan.steps.length}`);
  complexPlan.steps.forEach((step) => {
    console.log(`      ${step.order}. [${step.type}] ${step.description}`);
  });
}

runTests();
