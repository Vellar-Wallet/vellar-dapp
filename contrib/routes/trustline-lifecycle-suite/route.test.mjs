import assert from "node:assert/strict";
import { createState, handleRequest } from "./route.mjs";

const identity = {
  account: "GACCOUNT",
  assetCode: "USDC",
  issuer: "GISSUER",
};

let state = createState({ ...identity, balance: "0" });

let result = handleRequest("POST", "/add", { ...identity, balance: "0" }, state);
assert.equal(result.status, 200);
assert.equal(result.body.added, true);
state = result.state;

result = handleRequest("POST", "/check-removable", identity, state);
assert.equal(result.status, 200);
assert.equal(result.body.removable, true);
assert.equal(result.body.reason, null);

result = handleRequest("POST", "/remove", identity, state);
assert.equal(result.status, 200);
assert.equal(result.body.removed, true);
assert.equal(result.state.trustlines.length, 0);

const fundedState = createState({ ...identity, balance: "12.5000000" });
result = handleRequest("POST", "/check-removable", identity, fundedState);
assert.equal(result.status, 200);
assert.equal(result.body.removable, false);
assert.equal(result.body.reason, "trustline_balance_must_be_zero");

result = handleRequest("POST", "/remove", identity, fundedState);
assert.equal(result.status, 409);
assert.equal(result.body.removable, false);
assert.equal(result.body.reason, "trustline_balance_must_be_zero");
assert.equal(result.state.trustlines.length, 1);

console.log("PASS: trustline-lifecycle-suite tests");
