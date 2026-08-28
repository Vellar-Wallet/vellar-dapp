import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// List active policies
let res = handleRequest("GET", "/list-active");
assert.equal(res.status, 200);
assert.equal(res.body.length, 3);

// Transfer allowed by all policies
res = handleRequest("POST", "/check-transfer", { amount: 100, toAddress: "GABC" });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);
assert.equal(res.body.governedBy, null);

// Transfer exceeds pol_B limit (200) but not pol_A (500) — pol_B wins (higher precedence)
res = handleRequest("POST", "/check-transfer", { amount: 300, toAddress: "GABC" });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.equal(res.body.governedBy, "pol_B");

// Transfer exceeds both limits — pol_B still wins (higher precedence)
res = handleRequest("POST", "/check-transfer", { amount: 600, toAddress: "GABC" });
assert.equal(res.body.allowed, false);
assert.equal(res.body.governedBy, "pol_B");
assert.ok(res.body.allConflicts.length >= 2);

// Address not in allowlist — pol_C governs
res = handleRequest("POST", "/check-transfer", { amount: 100, toAddress: "GXXX" });
assert.equal(res.body.allowed, false);
assert.equal(res.body.governedBy, "pol_C");

// Missing params
res = handleRequest("POST", "/check-transfer", {});
assert.equal(res.status, 400);

console.log("PASS: policy-conflict suite — list, allow, spending-limit conflict, allowlist conflict, precedence resolved");
