const test = require("node:test");
const assert = require("node:assert/strict");

const { createWebhookRetryQueueRoute } = require("./route");

function createSequentialClock(isoTimestamps) {
  let index = 0;

  return () => {
    const value = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(value);
  };
}


test("webhook retry queue advances deterministically to a terminal state", () => {
  const route = createWebhookRetryQueueRoute({
    now: createSequentialClock([
      "2026-07-29T12:00:00.000Z",
      "2026-07-29T12:00:01.000Z",
      "2026-07-29T12:00:02.000Z",
      "2026-07-29T12:00:03.000Z",
      "2026-07-29T12:00:04.000Z",
    ]),
  });

  const enqueueResponse = route.handleRequest({
    method: "POST",
    path: "/deliveries",
  });

  assert.equal(enqueueResponse.statusCode, 201);
  assert.deepEqual(enqueueResponse.body, {
    deliveryId: "delivery-0001",
    status: "pending",
    retryCount: 0,
    createdAt: "2026-07-29T12:00:00.000Z",
  });

  const progression = [
    route.handleRequest({ method: "GET", path: "/deliveries/delivery-0001" }).body,
    route.handleRequest({ method: "GET", path: "/deliveries/delivery-0001" }).body,
    route.handleRequest({ method: "GET", path: "/deliveries/delivery-0001" }).body,
    route.handleRequest({ method: "GET", path: "/deliveries/delivery-0001" }).body,
  ];

  assert.deepEqual(
    progression.map((item) => ({
      status: item.status,
      retryCount: item.retryCount,
    })),
    [
      { status: "retrying", retryCount: 1 },
      { status: "retrying", retryCount: 2 },
      { status: "retrying", retryCount: 3 },
      { status: "delivered", retryCount: 3 },
    ],
  );

  assert.equal(progression.at(-1).maxRetries, 3);
  assert.equal(progression.at(-1).updatedAt, "2026-07-29T12:00:04.000Z");
});

test("webhook retry queue returns not found for unknown deliveries", () => {
  const route = createWebhookRetryQueueRoute();
  const response = route.handleRequest({
    method: "GET",
    path: "/deliveries/missing-delivery",
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error.message, "delivery missing-delivery was not found");
});
