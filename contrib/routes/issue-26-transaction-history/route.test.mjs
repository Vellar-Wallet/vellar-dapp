import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// No limit: returns the full sample set.
const full = handleRequest({ query: {} });
assert.equal(full.status, 200);
assert.ok(Array.isArray(full.body));
assert.equal(full.body.length, 5);
for (const tx of full.body) {
  assert.equal(typeof tx.hash, "string");
  assert.equal(typeof tx.amount, "string");
  assert.equal(typeof tx.timestamp, "string");
}

// limit=2: trims to the first 2 records.
const limited = handleRequest({ query: { limit: "2" } });
assert.equal(limited.body.length, 2);
assert.deepEqual(limited.body, full.body.slice(0, 2));

// limit larger than the sample set: returns everything, no padding.
const overLimit = handleRequest({ query: { limit: "100" } });
assert.equal(overLimit.body.length, 5);

// invalid limit: falls back to the full set.
const invalidLimit = handleRequest({ query: { limit: "not-a-number" } });
assert.equal(invalidLimit.body.length, 5);

console.log("PASS: /transactions honors the limit query parameter");
