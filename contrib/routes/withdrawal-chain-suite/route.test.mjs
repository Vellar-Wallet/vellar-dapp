import assert from "node:assert/strict";
import {
  getPolicy,
  requestWithdrawal,
  getRequest,
  approve,
  reject,
  parseAmount,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

// The policy is readable without submitting anything.
const policy = getPolicy();
assert.equal(policy.status, 200);
assert.deepEqual(
  policy.payload.tiers.map((tier) => tier.levelsRequired),
  [0, 1, 2],
);
assert.equal(policy.payload.levels[0].name, "operator");
assert.equal(policy.payload.levels[1].name, "compliance");
// lead-erin holds both roles; the separation-of-duties check below depends on it.
assert.ok(policy.payload.levels[0].approvers.includes("lead-erin"));
assert.ok(policy.payload.levels[1].approvers.includes("lead-erin"));

// ---------------------------------------------------------------------------
// Tier selection. Limits are inclusive, so each boundary is checked on both
// sides -- one stroop is the difference between a chain and no chain at all.
// ---------------------------------------------------------------------------
const tierOf = (amount) => requestWithdrawal({ account: "GA_TIER", amount }).payload;

assert.equal(tierOf("0.0000001").tier, "auto");
assert.equal(tierOf("499.9999999").levelsRequired, 0);
assert.equal(tierOf("500.0000000").levelsRequired, 0, "at the limit stays in the tier");
assert.equal(tierOf("500.0000001").levelsRequired, 1, "one stroop over moves up a tier");
assert.equal(tierOf("5000.0000000").tier, "operator");
assert.equal(tierOf("5000.0000001").tier, "dual");
assert.equal(tierOf("9007199254740993.0000001").levelsRequired, 2, "beyond MAX_SAFE_INTEGER");

// ---------------------------------------------------------------------------
// Zero levels: settled on submission, with no intermediate state.
// ---------------------------------------------------------------------------
const auto = requestWithdrawal({ account: "GA_SMALL", amount: "125.5" });
assert.equal(auto.status, 201);
assert.equal(auto.payload.tier, "auto");
assert.equal(auto.payload.status, "settled");
assert.equal(auto.payload.levelsRequired, 0);
assert.equal(auto.payload.remainingLevels, 0);
assert.equal(auto.payload.nextLevel, null);
assert.deepEqual(auto.payload.approvals, []);
assert.ok(auto.payload.settledAt);
assert.equal(auto.payload.amount, "125.5000000");

// Approving something that never needed approval says so, rather than
// reporting the generic "already closed".
let refused = approve({ id: auto.payload.id, approver: "ops-anna" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "no_approval_required");
assert.equal(
  reject({ id: auto.payload.id, approver: "ops-anna" }).payload.error,
  "no_approval_required",
);

// ---------------------------------------------------------------------------
// One level: an operator clears it.
// ---------------------------------------------------------------------------
const single = requestWithdrawal({ account: "GA_MID", amount: "2500", reference: "vendor" });
assert.equal(single.payload.tier, "operator");
assert.equal(single.payload.status, "pending_approval");
assert.equal(single.payload.remainingLevels, 1);
assert.equal(single.payload.nextLevel.level, 1);
assert.equal(single.payload.nextLevel.name, "operator");
assert.equal(single.payload.settledAt, null);
assert.equal(single.payload.reference, "vendor");

// Compliance cannot reach in and clear an operator-level request.
refused = approve({ id: single.payload.id, approver: "comp-carla" });
assert.equal(refused.status, 403);
assert.equal(refused.payload.error, "approver_not_authorised");
assert.equal(refused.payload.level, 1);
assert.ok(refused.payload.authorised.includes("ops-anna"));
assert.equal(
  getRequest(single.payload.id).payload.status,
  "pending_approval",
  "refusal is not a state change",
);

let cleared = approve({ id: single.payload.id, approver: "ops-anna" });
assert.equal(cleared.status, 200);
assert.equal(cleared.payload.status, "settled");
assert.equal(cleared.payload.remainingLevels, 0);
assert.equal(cleared.payload.nextLevel, null);
assert.equal(cleared.payload.approvals.length, 1);
assert.equal(cleared.payload.approvals[0].approver, "ops-anna");
assert.equal(cleared.payload.approvals[0].levelName, "operator");
assert.ok(cleared.payload.settledAt);

// A settled request is closed to further approvals.
refused = approve({ id: single.payload.id, approver: "ops-ben" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "request_closed");
assert.equal(getRequest(single.payload.id).payload.approvals.length, 1);

// ---------------------------------------------------------------------------
// Two levels, cleared in order.
// ---------------------------------------------------------------------------
const dual = requestWithdrawal({ account: "GA_LARGE", amount: "25000" });
assert.equal(dual.payload.tier, "dual");
assert.equal(dual.payload.levelsRequired, 2);
assert.equal(dual.payload.nextLevel.level, 1);

// The caller never names a level, so compliance cannot go first: comp-dan is
// simply not on the level-1 roster, and level 1 is what is pending.
assert.equal(
  approve({ id: dual.payload.id, approver: "comp-dan" }).payload.error,
  "approver_not_authorised",
);

let step = approve({ id: dual.payload.id, approver: "ops-ben" });
assert.equal(step.status, 200);
assert.equal(step.payload.status, "pending_approval", "one of two is not settled");
assert.equal(step.payload.remainingLevels, 1);
assert.equal(step.payload.nextLevel.level, 2);
assert.equal(step.payload.nextLevel.name, "compliance");
assert.equal(step.payload.settledAt, null);

// Now that level 2 is pending, an operator is the one who is out of scope.
assert.equal(
  approve({ id: dual.payload.id, approver: "ops-anna" }).payload.error,
  "approver_not_authorised",
);

step = approve({ id: dual.payload.id, approver: "comp-carla" });
assert.equal(step.payload.status, "settled");
assert.equal(step.payload.remainingLevels, 0);
assert.deepEqual(
  step.payload.approvals.map((a) => a.level),
  [1, 2],
);
assert.deepEqual(
  step.payload.approvals.map((a) => a.approver),
  ["ops-ben", "comp-carla"],
);

// ---------------------------------------------------------------------------
// Separation of duties. lead-erin is authorised at BOTH levels, so this is a
// real check -- the roster would happily let her through a second time.
// ---------------------------------------------------------------------------
const solo = requestWithdrawal({ account: "GA_SOLO", amount: "40000" });
assert.equal(approve({ id: solo.payload.id, approver: "lead-erin" }).payload.remainingLevels, 1);

refused = approve({ id: solo.payload.id, approver: "lead-erin" });
assert.equal(refused.status, 403);
assert.equal(refused.payload.error, "separation_of_duties");
assert.equal(refused.payload.alreadyApprovedLevel, 1);
assert.equal(refused.payload.attemptedLevel, 2);
assert.equal(getRequest(solo.payload.id).payload.approvals.length, 1, "the block records nothing");

// A different person finishes the chain.
assert.equal(approve({ id: solo.payload.id, approver: "comp-dan" }).payload.status, "settled");

// The same person may clear level 1 on one request and level 2 on another --
// the rule is per request, not per person.
const other = requestWithdrawal({ account: "GA_OTHER", amount: "40000" });
assert.equal(approve({ id: other.payload.id, approver: "ops-anna" }).status, 200);
assert.equal(approve({ id: other.payload.id, approver: "lead-erin" }).payload.status, "settled");

// ---------------------------------------------------------------------------
// Rejection ends the chain but keeps what was already recorded.
// ---------------------------------------------------------------------------
const doomed = requestWithdrawal({ account: "GA_DOOMED", amount: "9000" });
approve({ id: doomed.payload.id, approver: "ops-anna" });

const rejected = reject({ id: doomed.payload.id, approver: "comp-carla", reason: "sanctions hit" });
assert.equal(rejected.status, 200);
assert.equal(rejected.payload.status, "rejected");
assert.equal(rejected.payload.rejection.approver, "comp-carla");
assert.equal(rejected.payload.rejection.level, 2);
assert.equal(rejected.payload.rejection.reason, "sanctions hit");
assert.equal(rejected.payload.approvals.length, 1, "how far it got is preserved");
assert.equal(rejected.payload.remainingLevels, 0);
assert.equal(rejected.payload.nextLevel, null);

// A rejected request is closed, and cannot be revived by approving it.
assert.equal(
  approve({ id: doomed.payload.id, approver: "comp-dan" }).payload.error,
  "request_closed",
);
assert.equal(
  reject({ id: doomed.payload.id, approver: "comp-dan" }).payload.error,
  "request_closed",
);
assert.equal(getRequest(doomed.payload.id).payload.status, "rejected");

// Rejecting at the first level, before anything is approved.
const early = requestWithdrawal({ account: "GA_EARLY", amount: "9000" });
const earlyReject = reject({ id: early.payload.id, approver: "ops-ben" });
assert.equal(earlyReject.payload.rejection.level, 1);
assert.equal(earlyReject.payload.rejection.reason, null);
assert.deepEqual(earlyReject.payload.approvals, []);

// Only someone authorised for the pending level may reject it.
const guarded = requestWithdrawal({ account: "GA_GUARD", amount: "9000" });
assert.equal(
  reject({ id: guarded.payload.id, approver: "comp-dan" }).payload.error,
  "approver_not_authorised",
);
assert.equal(getRequest(guarded.payload.id).payload.status, "pending_approval");
assert.equal(
  reject({ id: guarded.payload.id, approver: "ops-anna", reason: 7 }).payload.field,
  "reason",
);

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------
for (const bad of ["", "-5", "0", "1e3", "0.00000001", "abc"]) {
  const res = requestWithdrawal({ account: "GA_X", amount: bad });
  assert.equal(res.status, 400, `expected ${JSON.stringify(bad)} to be rejected`);
  assert.equal(res.payload.field, "amount");
}
assert.equal(parseAmount("1e3"), null);
// A missing amount must not fall into the auto tier as zero.
assert.equal(requestWithdrawal({ account: "GA_X" }).payload.received, null);
assert.equal(requestWithdrawal({ amount: "10" }).payload.field, "account");
assert.equal(requestWithdrawal({ account: "  ", amount: "10" }).payload.field, "account");
assert.equal(
  requestWithdrawal({ account: "GA_X", amount: "10", reference: 7 }).payload.field,
  "reference",
);

assert.equal(getRequest("nope").status, 404);
assert.equal(getRequest("").status, 400);
assert.equal(approve({ id: "nope", approver: "ops-anna" }).status, 404);
assert.equal(approve({ id: dual.payload.id }).payload.field, "approver");
assert.equal(approve({ id: dual.payload.id, approver: "  " }).payload.field, "approver");
assert.equal(approve({}).payload.field, "id");
assert.equal(reject({}).payload.field, "id");

// A mutated response must not corrupt stored state.
const snapshot = getRequest(dual.payload.id);
snapshot.payload.approvals[0].approver = "tampered";
snapshot.payload.status = "rejected";
snapshot.payload.nextLevel = null;
assert.equal(getRequest(dual.payload.id).payload.approvals[0].approver, "ops-ben");
assert.equal(getRequest(dual.payload.id).payload.status, "settled");
// The policy rosters are copies too.
getPolicy().payload.levels[0].approvers.push("intruder");
assert.ok(!getPolicy().payload.levels[0].approvers.includes("intruder"));

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------
assert.equal(handleRequest("GET", "/policy").status, 200);
const routed = handleRequest("POST", "/request", { account: "GA_ROUTED", amount: "7500" });
assert.equal(routed.status, 201);
assert.equal(routed.payload.levelsRequired, 2);
assert.equal(handleRequest("GET", "/request", undefined, { id: routed.payload.id }).status, 200);
assert.equal(
  handleRequest("POST", "/approve", { id: routed.payload.id, approver: "ops-anna" }).status,
  200,
);
assert.equal(
  handleRequest("POST", "/reject", { id: routed.payload.id, approver: "comp-dan" }).payload.status,
  "rejected",
);
assert.equal(handleRequest("GET", "/approve", undefined, {}).status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

// resetState clears every request.
resetState();
assert.equal(getRequest(routed.payload.id).status, 404);

console.log(
  "PASS: /request tiers a withdrawal into 0, 1 or 2 approvals and /approve clears them in order under separation of duties",
);
