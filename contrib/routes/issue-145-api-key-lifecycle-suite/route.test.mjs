import assert from "node:assert/strict";
import { createApiKey, checkScope, revokeApiKey } from "./route.mjs";

// Create: valid scopes are accepted and deduplicated.
let { status, payload } = createApiKey({ scopes: ["accounts:read", "payments:sign", "accounts:read"] });
assert.equal(status, 201);
assert.deepEqual(payload.scopes, ["accounts:read", "payments:sign"]);
assert.equal(payload.revoked, false);
const { keyId } = payload;

// Create: missing scopes rejected.
const missingScopes = createApiKey({});
assert.equal(missingScopes.status, 400);
assert.equal(missingScopes.payload.error, "scopes_required");

// Check-scope: an allowed scope granted at creation time.
let check = checkScope(keyId, "accounts:read");
assert.equal(check.status, 200);
assert.equal(check.payload.allowed, true);

// Check-scope: a scope not included at creation time is disallowed.
check = checkScope(keyId, "admin:delete");
assert.equal(check.status, 200);
assert.equal(check.payload.allowed, false);
assert.equal(check.payload.reason, "scope_not_permitted");

// Check-scope: unknown key.
check = checkScope("does-not-exist", "accounts:read");
assert.equal(check.status, 404);
assert.equal(check.payload.error, "key_not_found");

// Revoke: succeeds for a known key.
const revoke = revokeApiKey(keyId);
assert.equal(revoke.status, 200);
assert.equal(revoke.payload.revoked, true);

// Post revoke: check-scope fails for any scope afterward, including one
// that was allowed before revocation.
check = checkScope(keyId, "accounts:read");
assert.equal(check.status, 200);
assert.equal(check.payload.allowed, false);
assert.equal(check.payload.reason, "revoked");

check = checkScope(keyId, "payments:sign");
assert.equal(check.payload.allowed, false);
assert.equal(check.payload.reason, "revoked");

// Revoke: unknown key.
const revokeUnknown = revokeApiKey("does-not-exist");
assert.equal(revokeUnknown.status, 404);
assert.equal(revokeUnknown.payload.error, "key_not_found");

console.log(
  "PASS: /api-keys handles create with scopes, an allowed scope, a disallowed scope, and post revoke rejection",
);
