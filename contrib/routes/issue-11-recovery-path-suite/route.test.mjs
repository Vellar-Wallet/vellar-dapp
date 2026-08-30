import assert from "node:assert/strict";
import { handleRequest, setPolicyState, resetState } from "./route.mjs";

const VALID_TOKEN = "passkey-sig-valid";
const INVALID_TOKEN = "wrong-token";

// --- Tests: owner can always remove the policy ---

// 1. Initial state — no policy attached
resetState();
let res = handleRequest("GET", "/recovery/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, false);
assert.deepEqual(res.body.recoveryOptions, []);

// 2. Attach a policy for testing
setPolicyState(true, "strict", "CDEPLOYED123");
res = handleRequest("GET", "/recovery/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, true);
assert.equal(res.body.mode, "strict");
assert.deepEqual(res.body.recoveryOptions, ["remove", "relax_to_trusted_publishers"]);

// 3. Owner can remove the policy (passkey auth)
res = handleRequest("POST", "/recovery/remove", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.removed, true);

// 4. Policy is gone after removal
res = handleRequest("GET", "/recovery/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, false);

// 5. Unauthorized caller cannot remove the policy
setPolicyState(true, "strict", "CDEPLOYED456");
res = handleRequest("POST", "/recovery/remove", { authToken: INVALID_TOKEN });
assert.equal(res.status, 403);
assert.equal(res.body.removed, false);
assert.ok(res.body.error.includes("passkey"));

// 6. Policy still attached after unauthorized attempt
res = handleRequest("GET", "/recovery/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, true);

// 7. Removal without auth token is rejected
res = handleRequest("POST", "/recovery/remove", {});
assert.equal(res.status, 403);

// 8. Removal when no policy is attached returns not-attached (not error)
resetState();
res = handleRequest("POST", "/recovery/remove", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.removed, false);
assert.equal(res.body.reason, "no_policy_attached");

// --- Tests: relaxation path ---

// 9. Owner can relax strict → trusted_publishers
setPolicyState(true, "strict", "CDEPLOYED789");
res = handleRequest("POST", "/recovery/relax", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.relaxed, true);
assert.equal(res.body.mode, "trusted_publishers");

// 10. Mode is updated
res = handleRequest("GET", "/recovery/status");
assert.equal(res.status, 200);
assert.equal(res.body.mode, "trusted_publishers");

// 11. Cannot relax when already not strict
res = handleRequest("POST", "/recovery/relax", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.relaxed, false);
assert.equal(res.body.reason, "already_not_strict");

// 12. Unauthorized caller cannot relax
setPolicyState(true, "strict", "CDEPLOYEDABC");
res = handleRequest("POST", "/recovery/relax", { authToken: INVALID_TOKEN });
assert.equal(res.status, 403);
assert.equal(res.body.relaxed, false);

// --- Tests: threat model ---

// 13. Threat model is documented
res = handleRequest("GET", "/recovery/threat-model");
assert.equal(res.status, 200);
assert.ok(res.body.summary.includes("session attacker"));
assert.ok(res.body.attackerCapabilities.length > 0);
assert.ok(res.body.ownerCapabilities.length > 0);
assert.ok(res.body.removalGuarantee.includes("never rejected"));

// 14. Removal is never blocked by the policy itself (the guarantee)
// This is verified by the fact that removal only checks auth, not policy state.
setPolicyState(true, "strict", "CDEPLOYEDXYZ");
res = handleRequest("POST", "/recovery/remove", { authToken: VALID_TOKEN });
assert.equal(res.status, 200);
assert.equal(res.body.removed, true);

// 15. 404 for unknown routes
res = handleRequest("GET", "/unknown");
assert.equal(res.status, 404);

console.log("PASS: Issue 11 recovery path suite — all 15 assertions passed");
