import assert from "node:assert/strict";
import { inspect, createPlan, getPlan, completeStep, resetState, handleRequest } from "./route.mjs";

resetState();

// Inspect: a dirty account reports every finding that applies to it.
let inspected = inspect("GA_DIRTY");
assert.equal(inspected.status, 200);
assert.equal(inspected.payload.account.account, "GA_DIRTY");
assert.equal(inspected.payload.needsCleanup, true);
assert.deepEqual(
  inspected.payload.findings.map((finding) => finding.kind),
  ["cancel-offers", "drain-balances", "close-trustlines", "remove-signers", "clear-flags"],
);

// Inspect: an already-clean account reports no findings.
inspected = inspect("GA_CLEAN");
assert.equal(inspected.status, 200);
assert.deepEqual(inspected.payload.findings, []);
assert.equal(inspected.payload.needsCleanup, false);

// Inspect: unknown account.
inspected = inspect("GA_NOBODY");
assert.equal(inspected.status, 404);
assert.equal(inspected.payload.error, "account_not_found");
assert.ok(inspected.payload.knownAccounts.includes("GA_DIRTY"));
assert.equal(inspect(undefined).status, 404);

// Plan: steps come back ordered and chained, with finalize last.
const created = createPlan({ account: "GA_DIRTY" });
assert.equal(created.status, 201);
const { planId } = created.payload;
assert.deepEqual(
  created.payload.steps.map((step) => step.id),
  [
    "cancel-offers",
    "drain-balances",
    "close-trustlines",
    "remove-signers",
    "clear-flags",
    "finalize",
  ],
);
assert.deepEqual(
  created.payload.steps.map((step) => step.order),
  [1, 2, 3, 4, 5, 6],
);
// Each step depends on the one before it; the first depends on nothing.
assert.equal(created.payload.steps[0].dependsOn, null);
for (let i = 1; i < created.payload.steps.length; i += 1) {
  assert.equal(created.payload.steps[i].dependsOn, created.payload.steps[i - 1].id);
}
assert.equal(created.payload.nextStep, "cancel-offers");
assert.equal(created.payload.complete, false);
assert.equal(created.payload.totalSteps, 6);
assert.equal(created.payload.completedCount, 0);
assert.ok(created.payload.steps.every((step) => step.status === "pending"));
assert.ok(created.payload.steps.every((step) => typeof step.reason === "string"));

// Plan: unknown account.
assert.equal(createPlan({ account: "GA_NOBODY" }).status, 404);
assert.equal(createPlan({}).status, 404);

// Skipping ahead to finalize is refused, and the plan is left untouched.
let refused = completeStep(planId, { step: "finalize" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "step_out_of_order");
assert.equal(refused.payload.expected, "cancel-offers");
assert.equal(refused.payload.received, "finalize");
assert.equal(refused.payload.blockedBy, "clear-flags");
assert.equal(getPlan(planId).payload.completedCount, 0);
assert.equal(getPlan(planId).payload.nextStep, "cancel-offers");

// Even skipping by one is refused.
refused = completeStep(planId, { step: "drain-balances" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.expected, "cancel-offers");
assert.equal(getPlan(planId).payload.completedCount, 0);

// The first step is accepted, and the next step advances by exactly one.
let done = completeStep(planId, { step: "cancel-offers" });
assert.equal(done.status, 200);
assert.equal(done.payload.completed, "cancel-offers");
assert.equal(done.payload.completedCount, 1);
assert.equal(done.payload.nextStep, "drain-balances");
assert.equal(done.payload.steps[0].status, "complete");
assert.ok(done.payload.steps[0].completedAt);
assert.equal(done.payload.complete, false);

// Re-completing a finished step is refused as already complete, not as
// out of order — the two failures mean different things to a caller.
refused = completeStep(planId, { step: "cancel-offers" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "step_already_complete");
assert.equal(refused.payload.completedCount, 1);

// A step that isn't in this plan at all is a 404, not a 409.
refused = completeStep(planId, { step: "not-a-step" });
assert.equal(refused.status, 404);
assert.equal(refused.payload.error, "step_not_in_plan");
assert.ok(refused.payload.planSteps.includes("finalize"));

// Working through the rest in order completes the plan.
for (const step of ["drain-balances", "close-trustlines", "remove-signers", "clear-flags"]) {
  assert.equal(completeStep(planId, { step }).status, 200, `expected ${step} to be accepted`);
}
let state = getPlan(planId);
assert.equal(state.payload.nextStep, "finalize");
assert.equal(state.payload.complete, false);
assert.equal(state.payload.completedCount, 5);

done = completeStep(planId, { step: "finalize" });
assert.equal(done.status, 200);
assert.equal(done.payload.complete, true);
assert.equal(done.payload.nextStep, null);
assert.equal(done.payload.completedCount, 6);
assert.ok(done.payload.steps.every((step) => step.status === "complete"));

// Nothing is completable once the plan is done.
assert.equal(completeStep(planId, { step: "finalize" }).payload.error, "step_already_complete");

// A partially dirty account only gets the steps that apply to it, still chained.
const partial = createPlan({ account: "GA_PARTIAL" });
assert.deepEqual(
  partial.payload.steps.map((step) => step.id),
  ["close-trustlines", "finalize"],
);
assert.equal(partial.payload.steps[0].dependsOn, null, "chain must re-anchor after skipped steps");
assert.equal(partial.payload.steps[1].dependsOn, "close-trustlines");
assert.equal(completeStep(partial.payload.planId, { step: "finalize" }).status, 409);
assert.equal(completeStep(partial.payload.planId, { step: "close-trustlines" }).status, 200);
assert.equal(completeStep(partial.payload.planId, { step: "finalize" }).payload.complete, true);

// A clean account still gets a plan — just the single finalize step.
const clean = createPlan({ account: "GA_CLEAN" });
assert.deepEqual(
  clean.payload.steps.map((step) => step.id),
  ["finalize"],
);
assert.equal(clean.payload.nextStep, "finalize");
assert.equal(completeStep(clean.payload.planId, { step: "finalize" }).payload.complete, true);

// Plans are independent: completing one must not advance another.
const planA = createPlan({ account: "GA_DIRTY" }).payload.planId;
const planB = createPlan({ account: "GA_DIRTY" }).payload.planId;
assert.notEqual(planA, planB);
completeStep(planA, { step: "cancel-offers" });
assert.equal(getPlan(planA).payload.completedCount, 1);
assert.equal(getPlan(planB).payload.completedCount, 0);

// A mutated plan response must not corrupt the stored plan.
const snapshot = getPlan(planB);
snapshot.payload.steps[0].status = "complete";
assert.equal(getPlan(planB).payload.steps[0].status, "pending");

// Unknown plan.
assert.equal(getPlan("no-such-plan").status, 404);
assert.equal(completeStep("no-such-plan", { step: "finalize" }).status, 404);

// Routing.
assert.equal(handleRequest("GET", "/inspect", undefined, { account: "GA_DIRTY" }).status, 200);
const routed = handleRequest("POST", "/plan", { account: "GA_PARTIAL" });
assert.equal(routed.status, 201);
const routedId = routed.payload.planId;
assert.equal(handleRequest("GET", `/plan/${routedId}`).payload.nextStep, "close-trustlines");
assert.equal(
  handleRequest("POST", `/plan/${routedId}/complete`, { step: "finalize" }).payload.error,
  "step_out_of_order",
);
assert.equal(
  handleRequest("POST", `/plan/${routedId}/complete`, { step: "close-trustlines" }).status,
  200,
);
assert.equal(handleRequest("DELETE", `/plan/${routedId}`).status, 404);
assert.equal(handleRequest("GET", "/nope").status, 404);

console.log(
  "PASS: /inspect finds cleanup work, /plan orders it into a dependency chain, and /plan/:id/complete accepts steps only in order",
);
