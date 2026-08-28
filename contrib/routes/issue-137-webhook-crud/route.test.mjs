import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

resetState();

const created = handleRequest({
  method: "POST",
  path: "/webhook-subscriptions",
  body: { url: "https://example.com/hooks/a", events: ["payment.settled"] },
});
assert.equal(created.status, 201);
assert.equal(created.body.url, "https://example.com/hooks/a");
const { id } = created.body;

const missingUrl = handleRequest({
  method: "POST",
  path: "/webhook-subscriptions",
  body: { events: ["payment.settled"] },
});
assert.equal(missingUrl.status, 400);
assert.equal(missingUrl.body.error, "url_required");

const missingEvents = handleRequest({
  method: "POST",
  path: "/webhook-subscriptions",
  body: { url: "https://example.com/hooks/b", events: [] },
});
assert.equal(missingEvents.status, 400);
assert.equal(missingEvents.body.error, "events_required");

const listed = handleRequest({ method: "GET", path: "/webhook-subscriptions" });
assert.equal(listed.status, 200);
assert.equal(listed.body.subscriptions.length, 1);
assert.equal(listed.body.subscriptions[0].id, id);

const deleted = handleRequest({ method: "DELETE", path: `/webhook-subscriptions/${id}` });
assert.equal(deleted.status, 200);
assert.equal(deleted.body.deleted, true);

const listedAfterDelete = handleRequest({ method: "GET", path: "/webhook-subscriptions" });
assert.equal(listedAfterDelete.body.subscriptions.length, 0);

const deleteUnknown = handleRequest({ method: "DELETE", path: "/webhook-subscriptions/sub_9999" });
assert.equal(deleteUnknown.status, 404);
assert.equal(deleteUnknown.body.error, "not_found");

console.log("PASS: /webhook-subscriptions supports create, list, then delete");
