import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.ok(Array.isArray(body));
assert.ok(body.length >= 5, "expected at least 5 sample policies");

for (const policy of body) {
  assert.equal(typeof policy.id, "string");
  assert.equal(typeof policy.type, "string");
  assert.equal(typeof policy.status, "string");
}

// The sample data varies both type and status, not just id.
const types = new Set(body.map((p) => p.type));
const statuses = new Set(body.map((p) => p.status));
assert.ok(types.size > 1, "expected varied policy types");
assert.ok(statuses.size > 1, "expected varied policy statuses");
assert.ok(types.has("spending-limit"));

console.log("PASS: /policies returns a varied array of policy summaries");
