import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

resetState();

let response = handleRequest({
  method: "POST",
  path: "/propose",
  body: { transaction: { to: "acct_demo", amount: "25" }, signers: ["alice", "bob", "carol"], threshold: 2 },
});
assert.equal(response.status, 201);
assert.equal(response.body.status, "pending");
const { proposalId } = response.body;

response = handleRequest({ method: "GET", path: "/status", query: { proposalId } });
assert.equal(response.status, 200);
assert.deepEqual(response.body.approvals, []);
assert.equal(response.body.approvalCount, 0);
assert.equal(response.body.status, "pending");

response = handleRequest({ method: "POST", path: "/approve", body: { proposalId, signer: "alice" } });
assert.equal(response.status, 200);
assert.deepEqual(response.body.approvals, ["alice"]);
assert.equal(response.body.status, "pending");

response = handleRequest({ method: "POST", path: "/approve", body: { proposalId, signer: "alice" } });
assert.equal(response.status, 409);
assert.equal(response.body.error, "duplicate_approval");

response = handleRequest({ method: "POST", path: "/approve", body: { proposalId, signer: "mallory" } });
assert.equal(response.status, 403);
assert.equal(response.body.error, "signer_not_allowed");

response = handleRequest({ method: "POST", path: "/approve", body: { proposalId, signer: "bob" } });
assert.equal(response.status, 200);
assert.deepEqual(response.body.approvals, ["alice", "bob"]);
assert.equal(response.body.approvalCount, 2);
assert.equal(response.body.threshold, 2);
assert.equal(response.body.status, "ready");

response = handleRequest({ method: "GET", path: "/status", query: { proposalId } });
assert.equal(response.body.status, "ready");
assert.equal(response.body.approvalCount, 2);

assert.equal(handleRequest({ method: "POST", path: "/propose", body: { transaction: {}, signers: ["alice"], threshold: 2 } }).status, 400);
assert.equal(handleRequest({ method: "GET", path: "/status", query: { proposalId: "missing" } }).status, 404);

console.log("PASS: multisig approval suite - unique approvals reach threshold and duplicates are rejected");