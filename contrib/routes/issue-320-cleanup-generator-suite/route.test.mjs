import assert from "node:assert/strict";
import { generateCleanupPlan, handleRequest } from "./route.mjs";

const ACCOUNT_ID = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const DESTINATION = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// Test 1: Account with 0 linked assets and 0 pending transactions -> mergeReady: true
const zeroAssetsPlan = generateCleanupPlan({
  accountId: ACCOUNT_ID,
  destination: DESTINATION,
  linkedAssets: [],
  pendingTransactions: [],
});
assert.equal(zeroAssetsPlan.mergeReady, true);
assert.equal(zeroAssetsPlan.blockers.length, 0);
assert.equal(zeroAssetsPlan.estimatedTransactions, 1);

// Test 2: Account with 1 linked asset -> 1 trustline blocker
const singleAssetPlan = generateCleanupPlan({
  accountId: ACCOUNT_ID,
  destination: DESTINATION,
  linkedAssets: [{ code: "USDC", issuer: DESTINATION }],
  pendingTransactions: [],
});
assert.equal(singleAssetPlan.mergeReady, false);
assert.equal(singleAssetPlan.blockers.length, 1);
assert.equal(singleAssetPlan.blockers[0].type, "trustline");
assert.equal(singleAssetPlan.estimatedTransactions, 2);

// Test 3: Account with many linked assets -> multiple trustline blockers
const manyAssetsPlan = generateCleanupPlan({
  accountId: ACCOUNT_ID,
  destination: DESTINATION,
  linkedAssets: [
    { code: "USDC", issuer: DESTINATION },
    { code: "EURC", issuer: DESTINATION },
    { code: "BTC", issuer: DESTINATION },
  ],
  pendingTransactions: [],
});
assert.equal(manyAssetsPlan.mergeReady, false);
assert.equal(manyAssetsPlan.blockers.length, 3);
assert.equal(manyAssetsPlan.estimatedTransactions, 4);

// Test 4: Account with pending transactions -> offer blocker
const pendingTxPlan = generateCleanupPlan({
  accountId: ACCOUNT_ID,
  destination: DESTINATION,
  linkedAssets: [],
  pendingTransactions: [{ id: "tx-1" }, { id: "tx-2" }],
});
assert.equal(pendingTxPlan.mergeReady, false);
assert.equal(pendingTxPlan.blockers.length, 1);
assert.equal(pendingTxPlan.blockers[0].type, "offer");
assert.ok(pendingTxPlan.blockers[0].description.includes("2 pending transaction(s)"));

// Test 5: Route handler simulation
const apiRes = handleRequest({
  body: {
    accountId: ACCOUNT_ID,
    destination: DESTINATION,
    linkedAssets: [{ code: "USDC", issuer: DESTINATION }],
  },
});
assert.equal(apiRes.status, 200);
assert.equal(apiRes.body.plan.mergeReady, false);

console.log("PASS: Issue 320 cleanup plan generator unit tests passed cleanly!");
