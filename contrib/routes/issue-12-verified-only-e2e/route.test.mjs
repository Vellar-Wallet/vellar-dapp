import assert from "node:assert/strict";
import { handleRequest, registerVerified, setPolicyState, resetState } from "./route.mjs";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CB" + "A".repeat(7) + "B".repeat(47);
const VALID_TOKEN = "passkey-sig-valid";
const INVALID_TOKEN = "wrong-token";

// Verify fixtures match the contract regex
assert.ok(/^C[A-Z2-7]{55}$/.test(C1), "C1 must be valid");
assert.ok(/^C[A-Z2-7]{55}$/.test(C2), "C2 must be valid");

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1: Blocked path — unverified contract → transaction rejected
// ═══════════════════════════════════════════════════════════════════════════

resetState();

// 1. No policy attached → transaction allowed
let res = handleRequest("POST", "/transaction/check", { targetContract: C1 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);

// 2. Attach the verified-only policy
res = handleRequest("POST", "/policy/attach", {
  registryAddress: C1,
  enforcementMode: "strict",
});
assert.equal(res.status, 201);
assert.equal(res.body.attached, true);
assert.equal(res.body.mode, "strict");

// 3. Policy is attached
res = handleRequest("GET", "/policy/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, true);
assert.equal(res.body.mode, "strict");

// 4. Unverified contract → transaction BLOCKED
res = handleRequest("POST", "/transaction/check", { targetContract: C2 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.equal(res.body.reason, "contract_not_verified");
assert.ok(res.body.explainer.title.includes("blocked"));
assert.ok(res.body.explainer.body.includes("does not mean"));
assert.ok(res.body.explainer.explorerUrl.includes(C2));

// 5. The blocked explainer endpoint returns honest copy
res = handleRequest("GET", "/explainer/blocked");
assert.equal(res.status, 200);
assert.ok(!res.body.explainer.body.toLowerCase().includes("guaranteed safe"));

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2: Allowed path — verified contract → transaction proceeds
// ═══════════════════════════════════════════════════════════════════════════

// 6. Register C1 as verified
registerVerified(C1);

// 7. Verified contract → transaction ALLOWED
res = handleRequest("POST", "/transaction/check", { targetContract: C1 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);
assert.equal(res.body.reason, null);

// 8. Verification endpoint shows verified status
res = handleRequest("GET", `/verification/${C1}`);
assert.equal(res.status, 200);
assert.equal(res.body.status, "verified");
assert.ok(res.body.records.length > 0);

// 9. Unverified contract still blocked
res = handleRequest("POST", "/transaction/check", { targetContract: C2 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);

// 10. Verification endpoint shows unverified status
res = handleRequest("GET", `/verification/${C2}`);
assert.equal(res.status, 200);
assert.equal(res.body.status, "unverified");
assert.equal(res.body.records.length, 0);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3: Recovery path (B11) — owner removes the policy
// ═══════════════════════════════════════════════════════════════════════════

// 11. Unauthorized removal rejected
res = handleRequest("POST", "/policy/remove", { authToken: INVALID_TOKEN });
assert.equal(res.status, 403);
assert.equal(res.body.removed, false);
assert.ok(res.body.error.includes("passkey"));

// 12. Policy still attached after unauthorized attempt
res = handleRequest("GET", "/policy/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, true);

// 13. Owner removes the policy with passkey auth
res = handleRequest("POST", "/policy/remove", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.removed, true);

// 14. Policy is gone
res = handleRequest("GET", "/policy/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, false);

// 15. Transactions no longer checked after policy removal
res = handleRequest("POST", "/transaction/check", { targetContract: C2 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);
assert.equal(res.body.reason, null);

// 16. Threat model is documented
res = handleRequest("GET", "/recovery/threat-model");
assert.equal(res.status, 200);
assert.ok(res.body.summary.includes("session attacker"));
assert.ok(res.body.removalGuarantee.includes("never rejected"));

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4: Edge cases
// ═══════════════════════════════════════════════════════════════════════════

// 17. Attach with invalid address → 422
res = handleRequest("POST", "/policy/attach", { registryAddress: "GINVALID" });
assert.equal(res.status, 422);

// 18. Check with missing targetContract → 422
res = handleRequest("POST", "/transaction/check", {});
assert.equal(res.status, 422);

// 19. Remove when nothing attached
resetState();
res = handleRequest("POST", "/policy/remove", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.removed, false);

// 20. 404 for unknown routes
res = handleRequest("GET", "/unknown");
assert.equal(res.status, 404);

// 21. Attach with trusted_publishers mode
res = handleRequest("POST", "/policy/attach", {
  registryAddress: C1,
  enforcementMode: "trusted_publishers",
});
assert.equal(res.status, 201);
assert.equal(res.body.mode, "trusted_publishers");

console.log("PASS: Issue 12 verified-only E2E suite — all 21 assertions passed");
