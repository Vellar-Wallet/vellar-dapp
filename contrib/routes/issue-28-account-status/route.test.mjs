import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// The account id path parameter is echoed back correctly.
const accountId = "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH";
const { status, body } = handleRequest({ params: { accountId } });

assert.equal(status, 200);
assert.equal(body.accountId, accountId);
assert.equal(typeof body.exists, "boolean");
assert.equal(typeof body.funded, "boolean");
assert.equal(typeof body.sequence, "string");

// A different account id is reflected back as-is, not hardcoded.
const otherId = "GXYZ999999999999999999999999999999999999999999999999999999";
const other = handleRequest({ params: { accountId: otherId } });
assert.equal(other.body.accountId, otherId);

// Missing account id is rejected.
const missing = handleRequest({ params: {} });
assert.equal(missing.status, 400);

console.log("PASS: /account-status/:accountId echoes the requested account id");
