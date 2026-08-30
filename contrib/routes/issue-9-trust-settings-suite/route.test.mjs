import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

// 1. Initial state — no policy attached
resetState();
let res = handleRequest("GET", "/trust/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, false);
assert.equal(res.body.mode, null);

// 2. Attach with valid definition
res = handleRequest("POST", "/trust/attach", {
  registryAddress: C1,
  enforcementMode: "strict",
});
assert.equal(res.status, 201);
assert.equal(res.body.attached, true);
assert.equal(res.body.mode, "strict");
assert.ok(res.body.contractId.startsWith("C"));
assert.ok(res.body.attachedAt);

// 3. Status now shows attached
res = handleRequest("GET", "/trust/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, true);
assert.equal(res.body.mode, "strict");

// 4. Attach rejected with invalid contract address (G… instead of C…)
res = handleRequest("POST", "/trust/attach", {
  registryAddress: G1,
  enforcementMode: "strict",
});
assert.equal(res.status, 422);
assert.ok(res.body.error.includes("Stellar contract address"));

// 5. Attach rejected with invalid enforcement mode
res = handleRequest("POST", "/trust/attach", {
  registryAddress: C1,
  enforcementMode: "invalid",
});
assert.equal(res.status, 422);
assert.ok(res.body.error.includes("enforcementMode"));

// 6. Attach rejected without registryAddress
res = handleRequest("POST", "/trust/attach", {});
assert.equal(res.status, 422);

// 7. Revoke fails without auth token
res = handleRequest("POST", "/trust/revoke", {});
assert.equal(res.status, 403);
assert.ok(res.body.error.includes("passkey"));

// 8. Revoke succeeds with valid auth token
res = handleRequest("POST", "/trust/revoke", { authToken: "passkey-sig-valid" });
assert.equal(res.status, 200);
assert.equal(res.body.removed, true);

// 9. Status back to unattached
res = handleRequest("GET", "/trust/status");
assert.equal(res.status, 200);
assert.equal(res.body.attached, false);

// 10. Revoke when nothing attached
res = handleRequest("POST", "/trust/revoke", { authToken: "passkey-sig-valid" });
assert.equal(res.status, 200);
assert.equal(res.body.removed, false);
assert.equal(res.body.reason, "no_policy_attached");

// 11. Revoke with wrong auth token
res = handleRequest("POST", "/trust/revoke", { authToken: "wrong-token" });
assert.equal(res.status, 403);

// 12. Descriptor endpoint returns honest copy
res = handleRequest("GET", "/trust/descriptor");
assert.equal(res.status, 200);
assert.ok(res.body.descriptor.includes("does not mean the contract is"));
assert.ok(res.body.caveats.length > 0);
assert.ok(res.body.caveats.some((c) => c.includes("audited")));

// 13. 404 for unknown routes
res = handleRequest("GET", "/unknown");
assert.equal(res.status, 404);

// 14. Attach with default mode (strict)
resetState();
res = handleRequest("POST", "/trust/attach", { registryAddress: C1 });
assert.equal(res.status, 201);
assert.equal(res.body.mode, "strict");

// 15. Attach with trusted_publishers mode
resetState();
res = handleRequest("POST", "/trust/attach", {
  registryAddress: C1,
  enforcementMode: "trusted_publishers",
});
assert.equal(res.status, 201);
assert.equal(res.body.mode, "trusted_publishers");

console.log("PASS: Issue 9 trust settings suite — all 15 assertions passed");
