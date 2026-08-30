import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Test successful deploy
let res = handleRequest("POST", "/deploy", { version: "v2.0.0" });
assert.equal(res.status, 200);
assert.equal(res.body.deployed, true);
assert.equal(res.body.version, "v2.0.0");
assert.equal(res.body.activeVersion, "v2.0.0");

// Test deploy status
res = handleRequest("GET", "/deploy-status");
assert.equal(res.status, 200);
assert.equal(res.body.status, "success");
assert.equal(res.body.activeVersion, "v2.0.0");

// Test rollback
res = handleRequest("POST", "/rollback");
assert.equal(res.status, 200);
assert.equal(res.body.rolledBack, true);
assert.equal(res.body.activeVersion, "v1.0.0");

// Test failed deploy then rollback
res = handleRequest("POST", "/deploy", { version: "v3.0.0", fail: true });
assert.equal(res.status, 200);
assert.equal(res.body.deployed, false);
assert.equal(res.body.activeVersion, "v1.0.0");

res = handleRequest("GET", "/deploy-status");
assert.equal(res.body.status, "failed");

res = handleRequest("POST", "/rollback");
assert.equal(res.body.rolledBack, true);
assert.equal(res.body.activeVersion, "v1.0.0");

// Test 404
res = handleRequest("GET", "/unknown");
assert.equal(res.status, 404);

console.log("PASS: policy-rollback suite — deploy, status, rollback, and failed-deploy+rollback all work");
