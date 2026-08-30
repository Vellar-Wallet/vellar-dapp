function createAgentKeyMintRoute(options = {}) {
  const now = options.now ?? (() => new Date());
  let nextKeyNumber = 1;

  function mintKey(body = {}) {
    const expirySecondsResult = validatePositiveNumber(body.expirySeconds, "expirySeconds");
    if (!expirySecondsResult.ok) {
      return expirySecondsResult.response;
    }

    const budgetResult = validatePositiveNumber(body.budget, "budget");
    if (!budgetResult.ok) {
      return budgetResult.response;
    }

    
    const createdAtDate = toDate(now());
    const createdAt = createdAtDate.toISOString();
    const expiresAt = new Date(
      createdAtDate.getTime() + expirySecondsResult.value * 1000,
    ).toISOString();
    const keyId = `mock-session-key-${String(nextKeyNumber).padStart(4, "0")}`;

    nextKeyNumber += 1;

    return jsonResponse(201, {
      keyId,
      expiresAt,
      budget: budgetResult.value,
      createdAt,
    });
  }

  function handleRequest(request = {}) {
    const method = normalizeMethod(request.method);
    const path = request.path ?? "";

    if (method === "POST" && path === "/session-keys/mint") {
      return mintKey(request.body);
    }

    return errorResponse(404, "route not found");
  }

  return {
    handleRequest,
    mintKey,
  };
}

function validatePositiveNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      response: errorResponse(400, `${fieldName} must be greater than 0`),
    };
  }

  return {
    ok: true,
    value,
  };
}

function normalizeMethod(method) {
  return typeof method === "string" ? method.toUpperCase() : "";
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
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

module.exports = {
  createAgentKeyMintRoute,
};
