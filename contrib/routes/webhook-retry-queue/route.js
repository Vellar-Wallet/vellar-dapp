const DEFAULT_MAX_RETRIES = 3;
 

function createWebhookRetryQueueRoute(options = {}) {
  const now = options.now ?? (() => new Date());
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const deliveries = new Map();
  let nextDeliveryNumber = 1;

  function enqueueDelivery() {
    const timestamp = toIsoTimestamp(now());
    const deliveryId = `delivery-${String(nextDeliveryNumber).padStart(4, "0")}`;

    nextDeliveryNumber += 1;

    const delivery = {
      deliveryId,
      status: "pending",
      retryCount: 0,
      maxRetries,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    deliveries.set(deliveryId, delivery);

    return jsonResponse(201, {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      retryCount: delivery.retryCount,
      createdAt: delivery.createdAt,
    });
  }

  function getDeliveryStatus(deliveryId) {
    if (!isNonEmptyString(deliveryId)) {
      return errorResponse(400, "deliveryId is required");
    }

    const normalizedDeliveryId = deliveryId.trim();
    const delivery = deliveries.get(normalizedDeliveryId);

    if (!delivery) {
      return errorResponse(404, `delivery ${normalizedDeliveryId} was not found`);
    }

    advanceDeliveryLifecycle(delivery, now);

    return jsonResponse(200, {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      retryCount: delivery.retryCount,
      maxRetries: delivery.maxRetries,
      updatedAt: delivery.updatedAt,
    });
  }

  function handleRequest(request = {}) {
    const method = normalizeMethod(request.method);
    const path = request.path ?? "";

    if (method === "POST" && path === "/deliveries") {
      return enqueueDelivery();
    }

    if (method === "GET" && path.startsWith("/deliveries/")) {
      return getDeliveryStatus(path.slice("/deliveries/".length));
    }

    return errorResponse(404, "route not found");
  }

  return {
    handleRequest,
    enqueueDelivery,
    getDeliveryStatus,
  };
}

function advanceDeliveryLifecycle(delivery, now) {
  if (delivery.status === "delivered" || delivery.status === "failed") {
    return delivery;
  }

  delivery.updatedAt = toIsoTimestamp(now());

  if (delivery.status === "pending") {
    delivery.status = "retrying";
    delivery.retryCount = 1;
    return delivery;
  }

  if (delivery.retryCount < delivery.maxRetries) {
    delivery.retryCount += 1;
    return delivery;
  }

  delivery.status = "delivered";
  return delivery;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body,
  };
}

function errorResponse(statusCode, message) {
  return jsonResponse(statusCode, {
    error: {
      message,
    },
  });
}

function normalizeMethod(method) {
  return typeof method === "string" ? method.toUpperCase() : "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

module.exports = {
  createWebhookRetryQueueRoute,
};
