import assert from "node:assert/strict";
import { handleRequest, resetState, signPayload, currentSecret } from "./route.mjs";

function deliver(payload, signature = signPayload(payload)) {
  return handleRequest({
    method: "POST",
    path: "/webhook/deliver",
    headers: { "x-vellar-signature": signature },
    body: payload,
  });
}

function verify(payload, signature) {
  return handleRequest({
    method: "POST",
    path: "/webhook/verify",
    body: { payload, signature },
  });
}

function rotate() {
  return handleRequest({ method: "POST", path: "/webhook/rotate-secret" });
}

resetState();

const payload = { id: "evt_001", event: "payment.settled" };

// A delivery signed with the active secret is accepted.
const delivered = deliver(payload);
assert.equal(delivered.status, 202);
assert.equal(delivered.body.delivered, true);

// The same payload verifies successfully against the active secret.
const signatureBeforeRotation = signPayload(payload);
const validVerify = verify(payload, signatureBeforeRotation);
assert.equal(validVerify.status, 200);
assert.equal(validVerify.body.verified, true);

// Rotating changes the active secret.
const secretBefore = currentSecret();
const rotated = rotate();
assert.equal(rotated.status, 200);
assert.equal(rotated.body.rotated, true);
assert.equal(rotated.body.rotationCount, 1);
assert.notEqual(currentSecret(), secretBefore);

// A payload signed with the previous secret now fails verify.
const failedAfterRotation = verify(payload, signatureBeforeRotation);
assert.equal(failedAfterRotation.status, 401);
assert.equal(failedAfterRotation.body.verified, false);
assert.equal(failedAfterRotation.body.error, "invalid_signature");

// A payload signed with the new active secret verifies fine.
const newSignature = signPayload(payload);
const validAfterRotation = verify(payload, newSignature);
assert.equal(validAfterRotation.status, 200);
assert.equal(validAfterRotation.body.verified, true);

// A delivery attempted with the stale (pre-rotation) signature is rejected.
const staleDelivery = deliver(
  { id: "evt_002", event: "payment.settled" },
  signPayload({ id: "evt_002", event: "payment.settled" }, secretBefore),
);
assert.equal(staleDelivery.status, 401);
assert.equal(staleDelivery.body.error, "invalid_signature");

// A second rotation moves the secret again, and the count increments.
rotate();
assert.equal(rotate().body.rotationCount, 3);

// Malformed payloads are rejected before any signature check.
assert.equal(verify({ event: "payment.settled" }, "irrelevant").status, 400);
assert.equal(deliver({ event: "payment.settled" }, "irrelevant").status, 400);

// A missing signature is a distinct error from an invalid one.
assert.equal(
  handleRequest({ method: "POST", path: "/webhook/verify", body: { payload } }).body.error,
  "missing_signature",
);

// Routing and method guards.
assert.equal(handleRequest({ method: "GET", path: "/webhook/deliver" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/webhook/rotate-secret" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/webhook/verify" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/webhook/unknown" }).status, 404);

console.log(
  "PASS: webhook-signature-suite delivers, rotates, and rejects stale signatures on verify",
);
