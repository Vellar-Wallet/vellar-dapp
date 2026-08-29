import http from "node:http";

export const CONTRACT_SCHEMAS = {
  getVerificationStatus: {
    request: { contractId: "regex:^C[A-Z2-7]{55}$" },
    response: {
      contractId: "string",
      status: "enum:unverified|submitted|building|verified|failed",
      records: "array",
    },
  },
  submitVerification: {
    request: {
      contractId: "string",
      sourceType: "string",
      repoUrl: "string",
      commitHash: "string",
      toolchainVersion: "string",
    },
    response: {
      record: {
        id: "string",
        contractId: "string",
        status: "string",
      },
    },
  },
};

export class ContractVerifier {
  static validateConsumerRequest(endpoint, payload) {
    const schema = CONTRACT_SCHEMAS[endpoint]?.request;
    if (!schema) return { valid: false, error: "Unknown endpoint schema" };

    for (const key of Object.keys(schema)) {
      if (!(key in payload)) {
        return { valid: false, error: `Missing required field: ${key}` };
      }
    }
    return { valid: true };
  }

  static validateProviderResponse(endpoint, response) {
    const schema = CONTRACT_SCHEMAS[endpoint]?.response;
    if (!schema) return { valid: false, error: "Unknown endpoint schema" };

    for (const key of Object.keys(schema)) {
      if (!(key in response)) {
        return { valid: false, error: `Missing response field: ${key}` };
      }
    }
    return { valid: true };
  }
}

export function handleRequest(endpoint, body) {
  if (endpoint === "getVerificationStatus") {
    const reqValidation = ContractVerifier.validateConsumerRequest(endpoint, body);
    if (!reqValidation.valid) return { status: 400, body: reqValidation };

    const providerRes = {
      contractId: body.contractId,
      status: "verified",
      records: [
        {
          id: "rec-101",
          contractId: body.contractId,
          sourceType: "repo",
          status: "verified",
        },
      ],
    };
    const resValidation = ContractVerifier.validateProviderResponse(endpoint, providerRes);
    return { status: resValidation.valid ? 200 : 500, body: providerRes };
  }

  if (endpoint === "submitVerification") {
    const reqValidation = ContractVerifier.validateConsumerRequest(endpoint, body);
    if (!reqValidation.valid) return { status: 400, body: reqValidation };

    const providerRes = {
      record: {
        id: "rec-102",
        contractId: body.contractId,
        status: "submitted",
      },
    };
    const resValidation = ContractVerifier.validateProviderResponse(endpoint, providerRes);
    return { status: resValidation.valid ? 201 : 500, body: providerRes };
  }

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (chunk) => (bodyStr += chunk));
    req.on("end", () => {
      let body = {};
      try {
        if (bodyStr) body = JSON.parse(bodyStr);
      } catch {}
      const endpoint = req.url.includes("submit") ? "submitVerification" : "getVerificationStatus";
      const { status, body: resBody } = handleRequest(endpoint, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  const port = process.env.PORT || 4317;
  server.listen(port, () => console.log(`issue-317 mock listening on port ${port}`));
}
