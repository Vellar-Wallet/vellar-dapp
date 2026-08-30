import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Request scopes
let res = handleRequest("POST", "/request-scopes", { scopes: ["read", "write", "admin"] });
assert.equal(res.status, 200);
assert.ok(res.body.requestId);
const requestId = res.body.requestId;
assert.deepEqual(res.body.requestedScopes, ["read", "write", "admin"]);

// Approve only a subset
res = handleRequest("POST", "/approve-scopes", { requestId, approvedScopes: ["read", "write"] });
assert.equal(res.status, 200);
assert.deepEqual(res.body.approved, ["read", "write"]);
assert.deepEqual(res.body.rejected, ["admin"]);

// Check approved scope
res = handleRequest("GET", "/check-scope", null, { requestId, scope: "read" });
assert.equal(res.status, 200);
assert.equal(res.body.approved, true);

res = handleRequest("GET", "/check-scope", null, { requestId, scope: "write" });
assert.equal(res.body.approved, true);

// Check rejected scope
res = handleRequest("GET", "/check-scope", null, { requestId, scope: "admin" });
assert.equal(res.status, 200);
assert.equal(res.body.approved, false);

// Missing params
res = handleRequest("POST", "/request-scopes", {});
assert.equal(res.status, 400);

res = handleRequest("GET", "/check-scope");
assert.equal(res.status, 400);

console.log("PASS: permission-scope suite — request, partial approve, check approved and rejected scopes");
