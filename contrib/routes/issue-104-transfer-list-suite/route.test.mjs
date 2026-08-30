import assert from "node:assert/strict";
import { handleRequest, clearLists } from "./route.mjs";

clearLists();

const ACCOUNT_A = "GBXACCOUNT11111111111111111111111111111111111111111111";
const RECIPIENT_ALLOWED = "GCXRECIPIENT222222222222222222222222222222222222222";
const RECIPIENT_DENIED = "GCXRECIPIENT333333333333333333333333333333333333333";
const RECIPIENT_CONFLICT = "GCXRECIPIENT444444444444444444444444444444444444444";

// 1. Add RECIPIENT_ALLOWED to allowlist
let res = handleRequest("POST", "/add-to-list", {
  account: ACCOUNT_A,
  listType: "allowlist",
  recipient: RECIPIENT_ALLOWED,
});
assert.equal(res.status, 200);
assert.equal(res.body.success, true);
assert.equal(res.body.listType, "allowlist");

// 2. Add RECIPIENT_DENIED to denylist
res = handleRequest("POST", "/add-to-list", {
  account: ACCOUNT_A,
  listType: "denylist",
  recipient: RECIPIENT_DENIED,
});
assert.equal(res.status, 200);
assert.equal(res.body.success, true);

// 3. Test ALLOWED transfer (recipient on allowlist, not on denylist)
res = handleRequest("POST", "/check-transfer", {
  account: ACCOUNT_A,
  recipient: RECIPIENT_ALLOWED,
  amount: "100",
});
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);
assert.equal(res.body.reason, null);

// 4. Test DENIED transfer (recipient on denylist)
res = handleRequest("POST", "/check-transfer", {
  account: ACCOUNT_A,
  recipient: RECIPIENT_DENIED,
  amount: "50",
});
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.ok(res.body.reason.includes("denylist"));

// 5. Test DENIED transfer (recipient not on allowlist when allowlist is active)
res = handleRequest("POST", "/check-transfer", {
  account: ACCOUNT_A,
  recipient: "GCUNLISTED99999999999999999999999999999999999999999",
  amount: "25",
});
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.ok(res.body.reason.includes("allowlist"));

// 6. Test CONFLICTING LIST PRECEDENCE CASE:
// Add RECIPIENT_CONFLICT to BOTH allowlist AND denylist
handleRequest("POST", "/add-to-list", {
  account: ACCOUNT_A,
  listType: "allowlist",
  recipient: RECIPIENT_CONFLICT,
});
handleRequest("POST", "/add-to-list", {
  account: ACCOUNT_A,
  listType: "denylist",
  recipient: RECIPIENT_CONFLICT,
});

// Check transfer for conflicting recipient: MUST BE REJECTED because denylist overrides allowlist
res = handleRequest("POST", "/check-transfer", {
  account: ACCOUNT_A,
  recipient: RECIPIENT_CONFLICT,
  amount: "500",
});
assert.equal(res.status, 200);
assert.equal(res.body.allowed, false);
assert.ok(res.body.reason.includes("denylist"));

// 7. Test remove-from-list
res = handleRequest("POST", "/remove-from-list", {
  account: ACCOUNT_A,
  listType: "denylist",
  recipient: RECIPIENT_CONFLICT,
});
assert.equal(res.status, 200);
assert.equal(res.body.success, true);

// Now RECIPIENT_CONFLICT is only on allowlist -> should be ALLOWED
res = handleRequest("POST", "/check-transfer", {
  account: ACCOUNT_A,
  recipient: RECIPIENT_CONFLICT,
});
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);

// 8. Test Input Validation & 400 Bad Request
res = handleRequest("POST", "/add-to-list", { account: ACCOUNT_A });
assert.equal(res.status, 400);

res = handleRequest("POST", "/check-transfer", {});
assert.equal(res.status, 400);

console.log("PASS: transfer-list-suite — allowed transfer, denied transfer, and conflicting list precedence case verified successfully!");
