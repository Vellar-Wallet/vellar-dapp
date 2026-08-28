import assert from "node:assert/strict";
import { handleRequest, KEY_TYPES } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.equal(typeof body.accountId, "string");
assert.ok(Array.isArray(body.signers));
assert.ok(body.signers.length >= 3, "at least three sample signers");

for (const signer of body.signers) {
  assert.equal(typeof signer.id, "string");
  assert.equal(typeof signer.label, "string");
  assert.equal(typeof signer.publicKey, "string");
  assert.ok(KEY_TYPES.includes(signer.keyType), `unexpected keyType: ${signer.keyType}`);
  assert.equal(typeof signer.weight, "number");
  assert.ok(signer.weight > 0, "weight must be positive");
  assert.ok(!Number.isNaN(Date.parse(signer.addedAt)), "addedAt must be a valid timestamp");
}

const ids = body.signers.map((s) => s.id);
assert.equal(new Set(ids).size, ids.length, "signer ids must be unique");

const usedKeyTypes = new Set(body.signers.map((s) => s.keyType));
assert.ok(usedKeyTypes.size >= 2, "sample data must cover varied key types");

console.log("PASS: /signer-list returns a well-formed signer array");
