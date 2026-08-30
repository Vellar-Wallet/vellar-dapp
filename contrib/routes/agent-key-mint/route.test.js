const test = require("node:test");
const assert = require("node:assert/strict");

const { createAgentKeyMintRoute } = require("./route");

test("agent key mint route returns deterministic mock session keys", () => {
  const route = createAgentKeyMintRoute({
    now: () => new Date("2026-07-29T14:30:00.000Z"),
  });

  
  const response = route.handleRequest({
    method: "POST",
    path: "/session-keys/mint",
    body: {
      expirySeconds: 90,
      budget: 250,
    },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, {
    keyId: "mock-session-key-0001",
    expiresAt: "2026-07-29T14:31:30.000Z",
    budget: 250,
    createdAt: "2026-07-29T14:30:00.000Z",
  });
});

test("agent key mint route rejects invalid payloads", () => {
  const route = createAgentKeyMintRoute();

  const expiryResponse = route.handleRequest({
    method: "POST",
    path: "/session-keys/mint",
    body: {
      expirySeconds: 0,
      budget: 10,
    },
  });

  assert.equal(expiryResponse.statusCode, 400);
  assert.equal(expiryResponse.body.error.message, "expirySeconds must be greater than 0");

  const budgetResponse = route.handleRequest({
    method: "POST",
    path: "/session-keys/mint",
    body: {
      expirySeconds: 60,
      budget: -1,
    },
  });

  assert.equal(budgetResponse.statusCode, 400);
  assert.equal(budgetResponse.body.error.message, "budget must be greater than 0");
});
