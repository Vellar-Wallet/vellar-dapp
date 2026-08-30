import assert from "node:assert/strict";
import { handleGet, handleRotate, _resetAddresses } from "./route.mjs";

_resetAddresses();

// Get: missing account id.
const missingAccount = handleGet(undefined);
assert.equal(missingAccount.status, 400);
assert.equal(missingAccount.body.error, "account_id_required");

// Get: seeded account returns its current address.
const initial = handleGet("acct_demo");
assert.equal(initial.status, 200);
assert.equal(initial.body.address, "GA000INITIALXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// Rotate: returns a new address distinct from the previous one.
const rotated = handleRotate("acct_demo");
assert.equal(rotated.status, 200);
assert.notEqual(rotated.body.address, initial.body.address);
assert.equal(rotated.body.previousAddress, initial.body.address);

// Get again: reflects the most recently rotated address.
const afterRotate = handleGet("acct_demo");
assert.equal(afterRotate.status, 200);
assert.equal(afterRotate.body.address, rotated.body.address);

// Rotate again: still produces a fresh, distinct address.
const rotatedTwice = handleRotate("acct_demo");
assert.notEqual(rotatedTwice.body.address, rotated.body.address);
assert.equal(rotatedTwice.body.previousAddress, rotated.body.address);
assert.equal(handleGet("acct_demo").body.address, rotatedTwice.body.address);

console.log("PASS: deposit address get, rotate, then get again confirms the change");
