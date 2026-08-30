import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const ACCOUNT = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB";

function makeReq(method, url, body) {
  const readable = {
    url,
    method,
    on: (event, cb) => {
      if (event === "data") cb(JSON.stringify(body || {}));
      if (event === "end") cb();
    },
  };
  return readable;
}

// Step 1: inspect
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: `/inspect?account=${ACCOUNT}`,
  });
  assert.equal(status, 200);
  assert.equal(body.account.account, ACCOUNT);
  assert.ok(body.pendingSteps.length >= 2);
}

// Step 2: check-ready (should not be ready)
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: `/check-ready?account=${ACCOUNT}`,
  });
  assert.equal(status, 200);
  assert.equal(body.ready, false);
  assert.ok(body.missingSteps.length > 0);
}

// Step 3: build-merge should refuse
{
  const req = makeReq("POST", "/build-merge", { account: ACCOUNT });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 400);
  assert.equal(body.error, "not_ready");
}

// Step 4: execute all required cleanup steps
for (const step of ["clear-flags", "remove-trustlines", "lower-signers"]) {
  const req = makeReq("POST", "/execute-cleanup-step", {
    account: ACCOUNT,
    step,
  });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.completed, true);
}

// Step 5: check-ready (should be ready now)
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: `/check-ready?account=${ACCOUNT}`,
  });
  assert.equal(status, 200);
  assert.equal(body.ready, true);
  assert.equal(body.missingSteps.length, 0);
}

// Step 6: build-merge should succeed
{
  const req = makeReq("POST", "/build-merge", { account: ACCOUNT });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.mergeTx.ready, true);
  assert.equal(body.balance, "1250.5000000");
}

console.log("PASS: full-cleanup-merge-suite tests");
