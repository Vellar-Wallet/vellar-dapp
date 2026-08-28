const test = require("node:test");
const assert = require("node:assert/strict");

const { createRateLimitConfigRoute } = require("./route");

test("rate limit route returns the deterministic default configuration", () => {
  const route = createRateLimitConfigRoute();

  const response = route.handleRequest({
    method: "GET",
    path: "/rate-limits/listPolicies",
  });

  
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    endpoint: "listPolicies",
    limit: 100,
    source: "default",
  });
});

test("rate limit route stores and returns custom configuration", () => {
  const route = createRateLimitConfigRoute({
    now: () => new Date("2026-07-29T13:00:00.000Z"),
  });

  const updateResponse = route.handleRequest({
    method: "PUT",
    path: "/rate-limits",
    body: {
      endpointName: "listPolicies",
      limit: 25,
    },
  });

  assert.equal(updateResponse.statusCode, 200);
  assert.deepEqual(updateResponse.body, {
    endpoint: "listPolicies",
    limit: 25,
    updatedAt: "2026-07-29T13:00:00.000Z",
  });

  const readResponse = route.handleRequest({
    method: "GET",
    path: "/rate-limits/listPolicies",
  });

  assert.equal(readResponse.statusCode, 200);
  assert.deepEqual(readResponse.body, {
    endpoint: "listPolicies",
    limit: 25,
    source: "custom",
    updatedAt: "2026-07-29T13:00:00.000Z",
  });
});

test("rate limit route rejects invalid input", () => {
  const route = createRateLimitConfigRoute();

  const cases = [
    {
      name: "missing endpointName",
      request: {
        method: "PUT",
        path: "/rate-limits",
        body: { limit: 10 },
      },
      expectedMessage: "endpointName is required",
    },
    {
      name: "zero limit",
      request: {
        method: "PUT",
        path: "/rate-limits",
        body: { endpointName: "listPolicies", limit: 0 },
      },
      expectedMessage: "limit must be a positive integer",
    },
    {
      name: "decimal limit",
      request: {
        method: "PUT",
        path: "/rate-limits",
        body: { endpointName: "listPolicies", limit: 2.5 },
      },
      expectedMessage: "limit must be a positive integer",
    },
    {
      name: "string limit",
      request: {
        method: "PUT",
        path: "/rate-limits",
        body: { endpointName: "listPolicies", limit: "20" },
      },
      expectedMessage: "limit must be a positive integer",
    },
    {
      name: "missing endpoint in get",
      request: {
        method: "GET",
        path: "/rate-limits/   ",
      },
      expectedMessage: "endpointName is required",
    },
  ];

  for (const testCase of cases) {
    const response = route.handleRequest(testCase.request);
    assert.equal(response.statusCode, 400, testCase.name);
    assert.equal(response.body.error.message, testCase.expectedMessage, testCase.name);
  }
});
