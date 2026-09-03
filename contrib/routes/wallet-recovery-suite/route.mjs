import http from "node:http";
import { pathToFileURL } from "node:url";

export function createState() {
  return {
    nextRequestId: 1,
    requests: new Map(),
    issuedSigners: new Map(),
  };
}

function requestRecovery(state, body) {
  const { accountId, fallbackSigner } = body || {};
  if (typeof accountId !== "string" || accountId === "" ||
      typeof fallbackSigner !== "string" || fallbackSigner === "") {
    return {
      status: 400,
      body: {
        error: "invalid_recovery_request",
        message: "accountId and fallbackSigner are required",
      },
    };
  }

  const recoveryRequestId = `recovery_${String(state.nextRequestId++).padStart(3, "0")}`;
  const verificationToken = `verify_${recoveryRequestId}`;
  state.requests.set(recoveryRequestId, {
    accountId,
    fallbackSigner,
    verificationToken,
    verified: false,
  });

  return {
    status: 201,
    body: {
      recoveryRequestId,
      status: "pending_verification",
      verificationToken,
    },
  };
}

function verifyFallback(state, body) {
  const recoveryRequestId = body?.recoveryRequestId;
  const verificationToken = body?.verificationToken;
  const request = state.requests.get(recoveryRequestId);

  if (!request) {
    return { status: 404, body: { error: "recovery_request_not_found" } };
  }
  if (verificationToken !== request.verificationToken) {
    return {
      status: 401,
      body: {
        error: "invalid_fallback_verification",
        message: "verification does not match this recovery request",
      },
    };
  }

  request.verified = true;
  return {
    status: 200,
    body: { recoveryRequestId, verified: true },
  };
}

function issueNewSigner(state, body) {
  const recoveryRequestId = body?.recoveryRequestId;
  const signer = body?.signer;
  const request = state.requests.get(recoveryRequestId);

  if (!request) {
    return { status: 404, body: { error: "recovery_request_not_found" } };
  }
  if (!request.verified) {
    return {
      status: 403,
      body: {
        error: "recovery_not_verified",
        message: "fallback verification is required for this recovery request",
      },
    };
  }
  if (typeof signer !== "string" || signer === "") {
    return { status: 400, body: { error: "signer_required" } };
  }
  if (state.issuedSigners.has(recoveryRequestId)) {
    return { status: 409, body: { error: "signer_already_issued" } };
  }

  state.issuedSigners.set(recoveryRequestId, signer);
  return {
    status: 201,
    body: {
      recoveryRequestId,
      accountId: request.accountId,
      signer,
      issued: true,
    },
  };
}

export function handleRequest(state, method, path, body) {
  if (method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/request-recovery") return requestRecovery(state, body);
  if (path === "/verify-fallback") return verifyFallback(state, body);
  if (path === "/issue-new-signer") return issueNewSigner(state, body);
  return { status: 404, body: { error: "not_found" } };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry !== null && import.meta.url === entry) {
  const state = createState();
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const result = body === null
      ? { status: 400, body: { error: "invalid_json" } }
      : handleRequest(state, req.method, new URL(req.url, "http://localhost").pathname, body);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4125;
  server.listen(port, () => {
    console.log(`wallet-recovery suite listening on http://localhost:${port}`);
  });
}
