import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.ok(Array.isArray(body.trustlines));
assert.ok(body.trustlines.length >= 3);
for (const t of body.trustlines) {
  assert.equal(typeof t.assetCode, "string");
  assert.equal(typeof t.issuer, "string");
  assert.equal(typeof t.balance, "string");
}

console.log("PASS: /trustline-list returns array of trustlines");
