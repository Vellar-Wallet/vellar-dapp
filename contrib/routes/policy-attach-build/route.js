function createPolicyAttachBuildRoute(options = {}) {
  const now = options.now ?? (() => new Date());
  const expiryWindowSeconds = options.expiryWindowSeconds ?? 300;

  function buildUnsignedTransaction(body = {}) {
    const policyIdResult = validateRequiredString(body.policyId, "policyId");
    if (!policyIdResult.ok) {
      return policyIdResult.response;
    }

    const accountIdResult = validateRequiredString(body.accountId, "accountId");
    if (!accountIdResult.ok) {
      return accountIdResult.response;
    }

    
    const createdAtDate = toDate(now());
    const timestamp = createdAtDate.getTime();
    const policyId = policyIdResult.value;
    const accountId = accountIdResult.value;

    return jsonResponse(200, {
      unsignedEnvelope: `unsigned-policy-${toEnvelopeToken(policyId)}-${toEnvelopeToken(accountId)}-${timestamp}`,
      expiry: new Date(createdAtDate.getTime() + expiryWindowSeconds * 1000).toISOString(),
      policyId,
      accountId,
    });
  }

  function handleRequest(request = {}) {
    const method = normalizeMethod(request.method);
    const path = request.path ?? "";

    if (method === "POST" && path === "/policy-attachments/build") {
      return buildUnsignedTransaction(request.body);
    }

    return errorResponse(404, "route not found");
  }

  return {
    handleRequest,
    buildUnsignedTransaction,
  };
}

function validateRequiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      response: errorResponse(400, `${fieldName} is required`),
    };
  }

  return {
    ok: true,
    value: value.trim(),
  };
}

function toEnvelopeToken(value) {
  return value.trim().replace(/\s+/g, "-");
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
  createPolicyAttachBuildRoute,
};
