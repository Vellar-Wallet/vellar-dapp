import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Found: a known session id is revoked and echoed back with its device details.
const hit = handleRequest({ params: { id: "ses_a1b2c3" } });
assert.equal(hit.status, 200);
assert.equal(hit.body.revoked, true);
assert.equal(hit.body.id, "ses_a1b2c3");
assert.equal(hit.body.device, "iPhone 15 Pro");
assert.equal(hit.body.platform, "ios");
assert.equal(Number.isNaN(Date.parse(hit.body.revokedAt)), false);

// Another known id resolves to its own record.
const other = handleRequest({ params: { id: "ses_g7h8i9" } });
assert.equal(other.status, 200);
assert.equal(other.body.id, "ses_g7h8i9");
assert.equal(other.body.device, "MacBook Pro");

// The sample dataset is read-only, so revoking the same id again still succeeds.
const repeat = handleRequest({ params: { id: "ses_a1b2c3" } });
assert.equal(repeat.status, 200);
assert.equal(repeat.body.id, "ses_a1b2c3");

// Not found: an unknown id returns a 404-style payload.
const miss = handleRequest({ params: { id: "ses_missing" } });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");
assert.match(miss.body.message, /ses_missing/);
assert.equal(miss.body.revoked, undefined);

// Not found: a missing, empty or non-string id is treated as a miss, not a crash.
assert.equal(handleRequest().status, 404);
assert.equal(handleRequest({ params: {} }).status, 404);
assert.equal(handleRequest({ params: { id: "" } }).status, 404);
assert.equal(handleRequest({ params: { id: 42 } }).status, 404);

// Ids inherited from Object.prototype are not treated as sessions.
assert.equal(handleRequest({ params: { id: "constructor" } }).status, 404);
assert.equal(handleRequest({ params: { id: "toString" } }).status, 404);

console.log("PASS: DELETE /device-sessions/:id revokes on a hit and 404s on a miss");
