import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

function subscribe(body) {
  return handleRequest({ method: "POST", path: "/webhooks/subscribe", body });
}

resetState();

// A valid subscription is accepted and echoes back a generated id.
const created = subscribe({
  url: "https://example.com/hook",
  events: ["payment.settled", "payment.failed"],
});
assert.equal(created.status, 201);
assert.equal(created.body.url, "https://example.com/hook");
assert.deepEqual(created.body.events, ["payment.settled", "payment.failed"]);
assert.equal(created.body.id, "sub_0001");
assert.equal(typeof created.body.createdAt, "string");

// Ids increment across subscriptions.
const second = subscribe({ url: "https://example.com/hook2", events: ["payment.settled"] });
assert.equal(second.body.id, "sub_0002");

// Missing url is rejected.
const missingUrl = subscribe({ events: ["payment.settled"] });
assert.equal(missingUrl.status, 400);
assert.equal(missingUrl.body.error, "invalid_url");

// Empty events array is rejected.
const emptyEvents = subscribe({ url: "https://example.com/hook", events: [] });
assert.equal(emptyEvents.status, 400);
assert.equal(emptyEvents.body.error, "invalid_events");

// Missing events field is rejected.
const missingEvents = subscribe({ url: "https://example.com/hook" });
assert.equal(missingEvents.status, 400);
assert.equal(missingEvents.body.error, "invalid_events");

// Routing and method guards.
assert.equal(handleRequest({ method: "GET", path: "/webhooks/subscribe" }).status, 405);
assert.equal(handleRequest({ method: "POST", path: "/unknown" }).status, 404);

console.log("PASS: webhook-subscribe validates input and returns a generated id");
