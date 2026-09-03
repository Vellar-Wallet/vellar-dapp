import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

let { status, body } = handleRequest("abc123def456");
assert.equal(status, 200);
assert.equal(body.hash, "abc123def456");
assert.equal(typeof body.amount, "string");
assert.equal(typeof body.timestamp, "string");

({ status, body } = handleRequest("nonexistent"));
assert.equal(status, 404);
assert.equal(body.error, "transaction_not_found");

({ status, body } = handleRequest());
assert.equal(status, 400);
assert.equal(body.error, "hash_required");

console.log("PASS: /transaction handles found, not found, and missing hash");
