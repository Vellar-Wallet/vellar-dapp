import assert from "node:assert/strict";
import { handleRequest, buildPlan, BLOCKER_TYPES } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.equal(typeof body.accountId, "string");
assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
assert.ok(Array.isArray(body.blockers));
assert.ok(body.blockers.length > 0, "sample plan has blockers to resolve");

for (const blocker of body.blockers) {
  assert.ok(BLOCKER_TYPES.includes(blocker.type), `unexpected blocker type: ${blocker.type}`);
  assert.equal(typeof blocker.description, "string");
  assert.ok(blocker.description.length > 0);
}

// mergeReady must track the blockers list in both directions.
assert.equal(typeof body.mergeReady, "boolean");
assert.equal(body.mergeReady, false, "plan with blockers is not merge ready");
assert.equal(body.mergeReady, body.blockers.length === 0);

const clean = buildPlan([]);
assert.equal(clean.mergeReady, true, "plan with no blockers is merge ready");
assert.deepEqual(clean.blockers, []);

const single = buildPlan([{ type: "signer", description: "Extra signer must be removed." }]);
assert.equal(single.mergeReady, false, "a single blocker still blocks the merge");

console.log("PASS: /cleanup-plan returns blockers and derives mergeReady correctly");
