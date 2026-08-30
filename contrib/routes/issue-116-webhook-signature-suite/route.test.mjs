import assert from "node:assert/strict";
import { handleRequest, resetState, signPayload } from "./route.mjs";

function deliver(payload, signature = signPayload(payload)) {
  return handleRequest({
    method: "POST",
    path: "/webhook/receive",
    headers: { "x-vellar-signature": signature },
    body: payload,
  });
}

function listProcessed() {
  return handleRequest({ method: "GET", path: "/webhook/processed-ids" });
}

resetState();

const payload = { id: "evt_001", event: "payment.settled" };

// Nothing has been processed yet.
assert.deepEqual(listProcessed().body, { ids: [], count: 0 });

// A valid first delivery is accepted and recorded.
const first = deliver(payload);
assert.equal(first.status, 202);
assert.equal(first.body.accepted, true);
assert.equal(first.body.id, "evt_001");
assert.deepEqual(listProcessed().body, { ids: ["evt_001"], count: 1 });

// The same payload delivered again is rejected as a replay.
const replay = deliver(payload);
assert.equal(replay.status, 409);
assert.equal(replay.body.error, "replay_detected");
assert.equal(listProcessed().body.count, 1);

// A payload with a bad signature is rejected and never recorded.
const forged = { id: "evt_002", event: "payment.settled" };
const bad = deliver(forged, "deadbeef");
assert.equal(bad.status, 401);
assert.equal(bad.body.error, "invalid_signature");
assert.deepEqual(listProcessed().body.ids, ["evt_001"]);

// A signature valid for a different payload does not carry over.
const swapped = deliver(forged, signPayload(payload));
assert.equal(swapped.status, 401);
assert.equal(swapped.body.error, "invalid_signature");

// Tampering with the event after signing invalidates the signature.
const tampered = deliver(
  { id: "evt_003", event: "payment.reversed" },
  signPayload({ id: "evt_003", event: "payment.settled" }),
);
assert.equal(tampered.status, 401);

// A missing signature header is rejected separately from a wrong one.
const unsigned = handleRequest({
  method: "POST",
  path: "/webhook/receive",
  headers: {},
  body: forged,
});
assert.equal(unsigned.status, 401);
assert.equal(unsigned.body.error, "missing_signature");

// A correctly signed second payload is accepted alongside the first.
const second = deliver(forged);
assert.equal(second.status, 202);
assert.deepEqual(listProcessed().body, { ids: ["evt_001", "evt_002"], count: 2 });

// Replaying an id with a valid signature is still rejected.
assert.equal(deliver(forged).status, 409);

// Malformed payloads are rejected before any signature check.
const malformed = deliver({ event: "payment.settled" }, "irrelevant");
assert.equal(malformed.status, 400);
assert.equal(malformed.body.error, "invalid_payload");

// Routing and method guards.
assert.equal(
  handleRequest({ method: "GET", path: "/webhook/receive" }).status,
  405,
);
assert.equal(
  handleRequest({ method: "POST", path: "/webhook/processed-ids" }).status,
  405,
);
assert.equal(
  handleRequest({ method: "GET", path: "/webhook/unknown" }).status,
  404,
);

console.log("PASS: webhook-signature suite verifies signatures and blocks replays");
