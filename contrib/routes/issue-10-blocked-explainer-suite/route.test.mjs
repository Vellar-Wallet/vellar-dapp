import assert from "node:assert/strict";
import { handleRequest, registerVerified, resetState } from "./route.mjs";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CB" + "A".repeat(7) + "B".repeat(47);
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

// Verify C1 and C2 match the contract address regex
assert.ok(/^C[A-Z2-7]{55}$/.test(C1), "C1 must be valid");
assert.ok(/^C[A-Z2-7]{55}$/.test(C2), "C2 must be valid");

resetState();

// 1. Blocked explainer returns honest copy
let res = handleRequest("GET", "/explainer/blocked");
assert.equal(res.status, 200);
assert.ok(res.body.explainer.title.includes("blocked"));
assert.ok(res.body.explainer.body.includes("does not mean"));
// Must never claim verified means safe
assert.ok(!res.body.explainer.body.toLowerCase().includes("verified means safe"));
assert.ok(!res.body.explainer.body.toLowerCase().includes("guaranteed safe"));
assert.ok(res.body.warn.body.includes("does not mean"));

// 2. Check: no policy attached → allowed
res = handleRequest("POST", "/explainer/check", { targetContract: C1, policyAttached: false });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);
assert.equal(res.body.reason, null);

// 3. Check: policy attached, unverified contract → blocked
res = handleRequest("POST", "/explainer/check", { targetContract: C1, policyAttached: true });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.equal(res.body.reason, "contract_not_verified");
assert.ok(res.body.explainer.explorerUrl.includes(C1));

// 4. Check: policy attached, verified contract → allowed
registerVerified(C1);
res = handleRequest("POST", "/explainer/check", { targetContract: C1, policyAttached: true });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);

// 5. Check: different unverified contract still blocked
res = handleRequest("POST", "/explainer/check", { targetContract: C2, policyAttached: true });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.equal(res.body.reason, "contract_not_verified");

// 6. Check: invalid contract address → 422
res = handleRequest("POST", "/explainer/check", { targetContract: G1, policyAttached: true });
assert.equal(res.status, 422);
assert.ok(res.body.error.includes("Stellar contract address"));

// 7. Check: missing targetContract → 422
res = handleRequest("POST", "/explainer/check", {});
assert.equal(res.status, 422);

// 8. Acknowledge warn path
res = handleRequest("POST", "/explainer/acknowledge", { contractId: C1 });
assert.equal(res.status, 200);
assert.equal(res.body.acknowledged, true);

// 9. Acknowledge without contractId → 422
res = handleRequest("POST", "/explainer/acknowledge", {});
assert.equal(res.status, 422);

// 10. 404 for unknown routes
res = handleRequest("GET", "/unknown");
assert.equal(res.status, 404);

// 11. Copy never claims verification equals safety (all user-facing strings)
res = handleRequest("GET", "/explainer/blocked");
const explainerText = res.body.explainer.body + res.body.warn.body;
const forbidden = ["guaranteed", "perfectly safe", "cannot be malicious", "trustworthy by default"];
for (const phrase of forbidden) {
  assert.ok(!explainerText.toLowerCase().includes(phrase), `copy must not contain "${phrase}"`);
}

console.log("PASS: Issue 10 blocked explainer suite — all 11 assertions passed");
