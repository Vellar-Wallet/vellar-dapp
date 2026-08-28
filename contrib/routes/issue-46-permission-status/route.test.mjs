import assert from "node:assert/strict";
import { handleRequest, GRANTS } from "./route.mjs";

// Known origin: reports the grant.
let { status, body } = handleRequest({ query: { origin: "https://app.example.com" } });
assert.equal(status, 200);
assert.equal(body.granted, true);
assert.equal(body.origin, "https://app.example.com");
assert.equal(body.grantId, GRANTS["https://app.example.com"].grantId);
assert.ok(Array.isArray(body.scopes) && body.scopes.length > 0);
assert.ok(!Number.isNaN(Date.parse(body.grantedAt)));

// Known origin with a path: normalized to the bare origin before lookup.
({ status, body } = handleRequest({ query: { origin: "https://app.example.com/settings" } }));
assert.equal(status, 200);
assert.equal(body.granted, true);
assert.equal(body.origin, "https://app.example.com");

// Unknown origin: granted is false, not an error.
({ status, body } = handleRequest({ query: { origin: "https://unknown.example.net" } }));
assert.equal(status, 200);
assert.equal(body.granted, false);
assert.deepEqual(body.scopes, []);
assert.equal(body.grantedAt, null);

// Missing origin parameter.
({ status, body } = handleRequest({ query: {} }));
assert.equal(status, 400);
assert.equal(body.error, "origin_required");

({ status, body } = handleRequest());
assert.equal(status, 400);
assert.equal(body.error, "origin_required");

// Malformed origin.
({ status, body } = handleRequest({ query: { origin: "not-a-url" } }));
assert.equal(status, 400);
assert.equal(body.error, "invalid_origin");

console.log("PASS: /permission-status handles known, unknown, missing, and malformed origins");
