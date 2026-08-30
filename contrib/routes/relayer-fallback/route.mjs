// Mock route simulating submitting a transaction through a primary relayer,
// falling back to a secondary path when the primary reports failure.
import http from "node:http";
import { pathToFileURL } from "node:url";

function submitToPrimary(transaction, forcePrimaryFailure) {
  if (forcePrimaryFailure) {
    return { ok: false, reason: "primary relayer forced failure for testing" };
  }
  return { ok: true, submissionId: `primary_${hashOf(transaction)}` };
}

function submitToFallback(transaction) {
  // The mock secondary path always succeeds; it exists to demonstrate the
  // fallback flow, not to model a secondary relayer's own failure modes.
  return { ok: true, submissionId: `fallback_${hashOf(transaction)}` };
}

// Deterministic stand-in for a submission id, not a real hash function.
function hashOf(transaction) {
  const s = typeof transaction === "string" ? transaction : JSON.stringify(transaction);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

export function handleRequest({ body = {} } = {}) {
  const { transaction, forcePrimaryFailure } = body;

  const validTransaction =
    (typeof transaction === "string" && transaction.trim() !== "") ||
    (typeof transaction === "object" && transaction !== null && !Array.isArray(transaction));
  if (!validTransaction) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "transaction must be a non-empty string or an object",
      },
    };
  }
  if (forcePrimaryFailure !== undefined && typeof forcePrimaryFailure !== "boolean") {
    return {
      status: 400,
      body: { error: "invalid_request", message: "forcePrimaryFailure must be a boolean" },
    };
  }

  const attempts = [];

  const primaryResult = submitToPrimary(transaction, forcePrimaryFailure === true);
  if (primaryResult.ok) {
    attempts.push({ path: "primary", ok: true });
    return {
      status: 200,
      body: { handledBy: "primary", submissionId: primaryResult.submissionId, attempts },
    };
  }
  attempts.push({ path: "primary", ok: false, reason: primaryResult.reason });

  const fallbackResult = submitToFallback(transaction);
  attempts.push({ path: "fallback", ok: true });
  return {
    status: 200,
    body: { handledBy: "fallback", submissionId: fallbackResult.submissionId, attempts },
  };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/relayer/submit") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "invalid_json", message: "Request body must be valid JSON" }),
          );
          return;
        }
        const { status, body: responseBody } = handleRequest({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4080;
  server.listen(port, () => {
    console.log(`relayer-fallback mock listening on http://localhost:${port}/relayer/submit`);
  });
}
