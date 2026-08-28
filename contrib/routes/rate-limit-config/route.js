const DEFAULT_LIMIT = 100;

function createRateLimitConfigRoute(options = {}) {
  const now = options.now ?? (() => new Date());
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const configurations = new Map();

  
  function setRateLimit(body = {}) {
    const endpointNameResult = validateEndpointName(body.endpointName);
    if (!endpointNameResult.ok) {
      return endpointNameResult.response;
    }

    const limitResult = validatePositiveInteger(body.limit, "limit");
    if (!limitResult.ok) {
      return limitResult.response;
    }

    const updatedAt = toIsoTimestamp(now());
    const endpoint = endpointNameResult.value;
    const configuration = {
      endpoint,
      limit: limitResult.value,
      updatedAt,
    };

    configurations.set(endpoint, configuration);

    return jsonResponse(200, configuration);
  }

  function getRateLimit(endpointName) {
    const endpointNameResult = validateEndpointName(endpointName);
    if (!endpointNameResult.ok) {
      return endpointNameResult.response;
    }

    const endpoint = endpointNameResult.value;
    const configuration = configurations.get(endpoint);

    if (!configuration) {
      return jsonResponse(200, {
        endpoint,
        limit: defaultLimit,
        source: "default",
      });
    }

    return jsonResponse(200, {
      endpoint: configuration.endpoint,
      limit: configuration.limit,
      source: "custom",
      updatedAt: configuration.updatedAt,
    });
  }

  function handleRequest(request = {}) {
    const method = normalizeMethod(request.method);
    const path = request.path ?? "";

    if (method === "PUT" && path === "/rate-limits") {
      return setRateLimit(request.body);
    }

    if (method === "GET" && path.startsWith("/rate-limits/")) {
      return getRateLimit(path.slice("/rate-limits/".length));
    }

    return errorResponse(404, "route not found");
  }

  return {
    handleRequest,
    setRateLimit,
    getRateLimit,
  };
}

function validateEndpointName(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      response: errorResponse(400, "endpointName is required"),
    };
  }

  return {
    ok: true,
    value: value.trim(),
  };
}

function validatePositiveInteger(value, fieldName) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return {
      ok: false,
      response: errorResponse(400, `${fieldName} must be a positive integer`),
    };
  }

  return {
    ok: true,
    value,
  };
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

function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

module.exports = {
  createRateLimitConfigRoute,
};
