import assert from "node:assert/strict";
import { handleRequest, DEFAULT_SCOPES } from "./route.mjs";

// Success: a valid origin is granted and echoed back, normalized.
let { status, body } = handleRequest({ origin: "https://app.example.com/dashboard" });
assert.equal(status, 201);
assert.equal(body.granted, true);
assert.equal(body.origin, "https://app.example.com");
assert.deepEqual(body.scopes, DEFAULT_SCOPES);
assert.match(body.grantId, /^grant_/);
assert.ok(!Number.isNaN(Date.parse(body.grantedAt)), "grantedAt must be a valid timestamp");

// Success: explicit scopes are echoed back, deduplicated.
({ status, body } = handleRequest({
  origin: "https://dapp.example.org",
  scopes: ["accounts:read", "payments:sign", "accounts:read"],
}));
assert.equal(status, 201);
assert.deepEqual(body.scopes, ["accounts:read", "payments:sign"]);

// Missing origin.
({ status, body } = handleRequest({ scopes: ["accounts:read"] }));
assert.equal(status, 400);
assert.equal(body.error, "origin_required");

// Missing body entirely.
({ status, body } = handleRequest());
assert.equal(status, 400);
assert.equal(body.error, "origin_required");

// Origin present but not a URL.
({ status, body } = handleRequest({ origin: "not-a-url" }));
assert.equal(status, 400);
assert.equal(body.error, "invalid_origin");

// Non-web protocols are rejected.
({ status, body } = handleRequest({ origin: "javascript:alert(1)" }));
assert.equal(status, 400);
assert.equal(body.error, "invalid_origin");

// Wrong type for origin.
({ status, body } = handleRequest({ origin: 42 }));
assert.equal(status, 400);
assert.equal(body.error, "origin_must_be_string");

// Unknown scope.
({ status, body } = handleRequest({ origin: "https://app.example.com", scopes: ["root"] }));
assert.equal(status, 400);
assert.equal(body.error, "invalid_scope");

console.log("PASS: /permission-grant handles valid grants, missing origin, and bad input");
