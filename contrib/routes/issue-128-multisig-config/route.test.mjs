import assert from "node:assert/strict";
import { getMultisigConfig, sampleAccountIds } from "./route.mjs";

// There must be at least 2 sample accounts with differing configurations.
assert.ok(sampleAccountIds.length >= 2);

// First sample account: shape check.
let { status, payload } = getMultisigConfig(sampleAccountIds[0]);
assert.equal(status, 200);
assert.equal(payload.account, sampleAccountIds[0]);
assert.equal(typeof payload.threshold, "number");
assert.ok(Array.isArray(payload.signers));
assert.ok(payload.signers.length > 0);
for (const signer of payload.signers) {
  assert.equal(typeof signer.key, "string");
  assert.equal(typeof signer.type, "string");
  assert.equal(typeof signer.weight, "number");
}

// Second sample account: differing threshold/signer count from the first.
const second = getMultisigConfig(sampleAccountIds[1]);
assert.equal(second.status, 200);
assert.notEqual(second.payload.threshold, payload.threshold);
assert.notEqual(second.payload.signers.length, payload.signers.length);

// Unknown account.
({ status, payload } = getMultisigConfig("GUNKNOWNACCOUNT0000000000000000000000000000000000000000"));
assert.equal(status, 404);
assert.equal(payload.error, "account_not_found");

console.log("PASS: /multisig-config returns sample accounts with the expected response shape");
