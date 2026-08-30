import assert from "node:assert/strict";
import { handleRequest, SAMPLE_SUBSCRIPTIONS } from "./route.mjs";

const { status, body } = handleRequest({ method: "GET", path: "/webhook-subscriptions" });
assert.equal(status, 200);
assert.ok(Array.isArray(body.subscriptions));
assert.ok(body.subscriptions.length >= 3);

const eventTypes = new Set();
for (const sub of body.subscriptions) {
  assert.equal(typeof sub.url, "string");
  assert.ok(sub.url.length > 0);
  assert.ok(Array.isArray(sub.events));
  assert.ok(sub.events.length > 0);
  for (const evt of sub.events) eventTypes.add(evt);
}
assert.ok(eventTypes.size >= 3, "sample entries should have varied event types");
assert.equal(SAMPLE_SUBSCRIPTIONS.length, body.subscriptions.length);

const { status: badMethod } = handleRequest({ method: "POST", path: "/webhook-subscriptions" });
assert.equal(badMethod, 405);

const { status: notFound } = handleRequest({ method: "GET", path: "/nope" });
assert.equal(notFound, 404);

console.log("PASS: /webhook-subscriptions returns varied sample subscription records");
