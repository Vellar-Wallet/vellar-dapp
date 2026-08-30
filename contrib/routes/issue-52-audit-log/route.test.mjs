import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.ok(Array.isArray(body.entries));
assert.ok(body.entries.length >= 5);

for (const entry of body.entries) {
  assert.equal(typeof entry.actor, "string");
  assert.ok(entry.actor.length > 0);
  assert.equal(typeof entry.action, "string");
  assert.ok(entry.action.length > 0);
  assert.equal(typeof entry.timestamp, "string");
  // Timestamps are ISO-8601 UTC strings.
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
}

// The sample data uses varied actions rather than repeating one.
const actions = new Set(body.entries.map((e) => e.action));
assert.ok(actions.size >= 5);

console.log("PASS: /audit-log returns an array of audit entries with actor, action, timestamp");
