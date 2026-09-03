import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Success case: all required fields present.
const success = handleRequest({
  body: {
    recipient: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
    amount: "25.0000000",
    asset: "XLM",
  },
});
assert.equal(success.status, 200);
assert.equal(success.body.valid, true);
assert.equal(success.body.recipient, "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH");

// Error case: missing "amount".
const missingAmount = handleRequest({
  body: { recipient: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH", asset: "XLM" },
});
assert.equal(missingAmount.status, 400);
assert.equal(missingAmount.body.error, "invalid_request");
assert.deepEqual(missingAmount.body.missingFields, ["amount"]);

// Error case: empty body, all fields missing.
const emptyBody = handleRequest({ body: {} });
assert.equal(emptyBody.status, 400);
assert.deepEqual(emptyBody.body.missingFields, ["recipient", "amount", "asset"]);

console.log("PASS: /payment-request validates recipient, amount, asset");
