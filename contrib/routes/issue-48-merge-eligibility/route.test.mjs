import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// An eligible account reports eligible: true with an empty reasons array.
const eligible = handleRequest({ params: { accountId: "acc_1001" } });
assert.equal(eligible.status, 200);
assert.equal(eligible.body.accountId, "acc_1001");
assert.equal(eligible.body.eligible, true);
assert.ok(Array.isArray(eligible.body.reasons));
assert.equal(eligible.body.reasons.length, 0);

// An ineligible account reports eligible: false and lists why.
const ineligible = handleRequest({ params: { accountId: "acc_1002" } });
assert.equal(ineligible.status, 200);
assert.equal(ineligible.body.eligible, false);
assert.ok(Array.isArray(ineligible.body.reasons));
assert.ok(ineligible.body.reasons.length > 0);
for (const reason of ineligible.body.reasons) {
  assert.equal(typeof reason, "string");
}

// The returned reasons array is a copy, so callers cannot mutate the dataset.
ineligible.body.reasons.push("tampered");
const refetched = handleRequest({ params: { accountId: "acc_1002" } });
assert.ok(!refetched.body.reasons.includes("tampered"));

// An unknown account id returns a 404-style payload.
const miss = handleRequest({ params: { accountId: "acc_9999" } });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");

// A missing account id is also treated as not found.
const noId = handleRequest({});
assert.equal(noId.status, 404);

console.log(
  "PASS: /accounts/:accountId/merge-eligibility reports eligible and ineligible accounts",
);
