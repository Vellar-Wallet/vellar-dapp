import assert from "node:assert/strict";
import {
  getPolicy,
  requestWithdrawal,
  getStatus,
  parseAmount,
  formatAmount,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

// The policy is readable without submitting anything.
const policy = getPolicy();
assert.equal(policy.status, 200);
assert.equal(policy.payload.threshold, "500.0000000");
assert.equal(policy.payload.asset, "XLM");

// Amount parsing: the shapes that must be accepted.
assert.equal(parseAmount("1"), 10_000_000n);
assert.equal(parseAmount("0.0000001"), 1n);
assert.equal(parseAmount(250), 2_500_000_000n);
assert.equal(parseAmount(" 12.5 "), 125_000_000n);

// ...and the shapes that must not be, each of which Number() would accept.
for (const bad of ["", "  ", "-5", "0", "0.00000001", "abc", "1e3", "1.2.3", "Infinity", "NaN"]) {
  assert.equal(parseAmount(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
}
assert.equal(parseAmount(Number.NaN), null);
assert.equal(parseAmount(Number.POSITIVE_INFINITY), null);
assert.equal(parseAmount(null), null);
assert.equal(parseAmount(undefined), null);
assert.equal(parseAmount({}), null);

// Round-tripping normalises to 7 decimals.
assert.equal(formatAmount(parseAmount("12.5")), "12.5000000");
assert.equal(formatAmount(parseAmount("0.0000001")), "0.0000001");

// Below the threshold: auto-approved.
let created = requestWithdrawal({ account: "GA_ALICE", amount: "125.0000000" });
assert.equal(created.status, 201);
assert.equal(created.payload.requiresApproval, false);
assert.equal(created.payload.status, "auto_approved");
assert.equal(created.payload.amount, "125.0000000");
assert.equal(created.payload.threshold, "500.0000000");
assert.equal(created.payload.reference, null);
assert.ok(created.payload.id);
assert.ok(created.payload.requestedAt);

// Above the threshold: needs a human.
const large = requestWithdrawal({
  account: "GA_ALICE",
  amount: "500.0000001",
  reference: "payroll",
});
assert.equal(large.status, 201);
assert.equal(large.payload.requiresApproval, true);
assert.equal(large.payload.status, "pending_approval");
assert.equal(large.payload.reference, "payroll");

// The boundary is the point of the suite: *at* the threshold is still automatic,
// and one stroop over is not. This is the assertion a float comparison breaks.
assert.equal(requestWithdrawal({ account: "GA_B", amount: "500" }).payload.requiresApproval, false);
assert.equal(
  requestWithdrawal({ account: "GA_B", amount: "500.0000000" }).payload.requiresApproval,
  false,
);
assert.equal(
  requestWithdrawal({ account: "GA_B", amount: "500.0000001" }).payload.requiresApproval,
  true,
);

// Amounts far past Number.MAX_SAFE_INTEGER stroops still compare exactly.
const huge = requestWithdrawal({ account: "GA_WHALE", amount: "9007199254740993.0000001" });
assert.equal(huge.payload.requiresApproval, true);
assert.equal(huge.payload.amount, "9007199254740993.0000001");

// Invalid input is refused rather than defaulted.
let refused = requestWithdrawal({ account: "GA_ALICE", amount: "-1" });
assert.equal(refused.status, 400);
assert.equal(refused.payload.error, "invalid_request");
assert.equal(refused.payload.field, "amount");
assert.equal(refused.payload.received, "-1");

// A missing amount must not be read as zero and auto-approved.
refused = requestWithdrawal({ account: "GA_ALICE" });
assert.equal(refused.status, 400);
assert.equal(refused.payload.field, "amount");
assert.equal(refused.payload.received, null);

assert.equal(requestWithdrawal({ amount: "10" }).payload.field, "account");
assert.equal(requestWithdrawal({ account: "   ", amount: "10" }).payload.field, "account");
assert.equal(requestWithdrawal({}).status, 400);
assert.equal(
  requestWithdrawal({ account: "GA_ALICE", amount: "10", reference: 7 }).payload.field,
  "reference",
);

// A rejected request is not stored.
assert.equal(getStatus(refused.payload.id).status, 400);

// Checking a stored request returns the decision made at request time.
let status = getStatus(large.payload.id);
assert.equal(status.status, 200);
assert.equal(status.payload.id, large.payload.id);
assert.equal(status.payload.requiresApproval, true);
assert.equal(status.payload.status, "pending_approval");
assert.equal(status.payload.amount, "500.0000001");

// Requests are independent records, not a single global decision.
assert.equal(getStatus(created.payload.id).payload.requiresApproval, false);

// Unknown and malformed ids.
assert.equal(getStatus("not-a-real-id").status, 404);
assert.equal(getStatus("not-a-real-id").payload.error, "request_not_found");
assert.equal(getStatus("").status, 400);
assert.equal(getStatus(undefined).status, 400);

// A mutated response must not rewrite the stored decision.
status = getStatus(large.payload.id);
status.payload.requiresApproval = false;
status.payload.amount = "0.0000001";
assert.equal(getStatus(large.payload.id).payload.requiresApproval, true);
assert.equal(getStatus(large.payload.id).payload.amount, "500.0000001");

// The frozen policy object cannot be edited out from under a caller either.
getPolicy().payload.threshold = "1.0000000";
assert.equal(getPolicy().payload.threshold, "500.0000000");

// Routing.
assert.equal(handleRequest("GET", "/policy").status, 200);
const routed = handleRequest("POST", "/request", { account: "GA_ROUTED", amount: "900" });
assert.equal(routed.status, 201);
assert.equal(routed.payload.requiresApproval, true);
assert.equal(handleRequest("GET", "/status", undefined, { id: routed.payload.id }).status, 200);
assert.equal(handleRequest("GET", "/status", undefined, {}).status, 400);
assert.equal(handleRequest("POST", "/policy", {}).status, 404);
assert.equal(handleRequest("GET", "/request", undefined, {}).status, 404);
assert.equal(handleRequest("DELETE", "/status", undefined, {}).status, 404);

// resetState clears stored requests.
resetState();
assert.equal(getStatus(routed.payload.id).status, 404);

console.log(
  "PASS: /request admits a withdrawal under an exact stroop threshold and /status reports the approval decision it was admitted under",
);
