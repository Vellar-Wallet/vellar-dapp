const test = require("node:test");
const assert = require("node:assert/strict");

const { createPolicyAttachBuildRoute } = require("./route");

test("policy attach build route returns a deterministic unsigned envelope", () => {
  const route = createPolicyAttachBuildRoute({
    now: () => new Date("2026-07-29T15:45:00.000Z"),
  });

  
  const response = route.handleRequest({
    method: "POST",
    path: "/policy-attachments/build",
    body: {
      policyId: "policy-123",
      accountId: "account-789",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.unsignedEnvelope,
    "unsigned-policy-policy-123-account-789-1785339900000",
  );
  assert.equal(response.body.policyId, "policy-123");
  assert.equal(response.body.accountId, "account-789");
  assert.equal(response.body.expiry, "2026-07-29T15:50:00.000Z");
  assert.notEqual(response.body.unsignedEnvelope.length, 0);
});

test("policy attach build route validates required fields", () => {
  const route = createPolicyAttachBuildRoute();

  const missingPolicyResponse = route.handleRequest({
    method: "POST",
    path: "/policy-attachments/build",
    body: {
      policyId: "   ",
      accountId: "account-789",
    },
  });

  assert.equal(missingPolicyResponse.statusCode, 400);
  assert.equal(missingPolicyResponse.body.error.message, "policyId is required");

  const missingAccountResponse = route.handleRequest({
    method: "POST",
    path: "/policy-attachments/build",
    body: {
      policyId: "policy-123",
      accountId: "",
    },
  });

  assert.equal(missingAccountResponse.statusCode, 400);
  assert.equal(missingAccountResponse.body.error.message, "accountId is required");
});
