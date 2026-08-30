// Mock route module simulating a payment build-then-submit flow.
// POST /payment/build validates a payment payload and returns a draft id.
// POST /payment/submit/:draftId submits a previously built draft and
// returns a fake transaction hash. No chain or DB access.
import http from "node:http";
import crypto from "node:crypto";

const REQUIRED_FIELDS = ["recipient", "amount", "asset"];

// In-memory draft store, keyed by draftId. Cleared whenever the process
// restarts -- this is a mock, not a persistence layer.
const drafts = new Map();

function validatePayload(body = {}) {
  const missingFields = REQUIRED_FIELDS.filter(
    (field) => body[field] === undefined || body[field] === null || body[field] === "",
  );
  return missingFields;
}

function makeDraftId() {
  return `draft_${crypto.randomBytes(6).toString("hex")}`;
}

function makeTxHash() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Builds a mock payment draft.
 * @param {{body?: object}} input
 */
export function handleBuild({ body = {} } = {}) {
  const missingFields = validatePayload(body);
  if (missingFields.length > 0) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: `Missing required field(s): ${missingFields.join(", ")}`,
        missingFields,
      },
    };
  }

  const draftId = makeDraftId();
  const draft = {
    draftId,
    recipient: body.recipient,
    amount: body.amount,
    asset: body.asset,
    status: "built",
    createdAt: new Date().toISOString(),
  };
  drafts.set(draftId, draft);

  return { status: 200, body: draft };
}

/**
 * Submits a previously built draft.
 * @param {{draftId?: string}} input
 */
export function handleSubmit({ draftId } = {}) {
  const draft = drafts.get(draftId);

  if (!draft) {
    return {
      status: 404,
      body: {
        error: "draft_not_found",
        message: `No draft found for draftId "${draftId}"`,
      },
    };
  }

  if (draft.status === "submitted") {
    return {
      status: 409,
      body: {
        error: "already_submitted",
        message: `Draft "${draftId}" has already been submitted`,
        txHash: draft.txHash,
      },
    };
  }

  const txHash = makeTxHash();
  draft.status = "submitted";
  draft.txHash = txHash;
  draft.submittedAt = new Date().toISOString();

  return {
    status: 200,
    body: {
      draftId,
      status: "submitted",
      txHash,
      submittedAt: draft.submittedAt,
    },
  };
}

/** Test-only helper to reset in-memory state between test files/runs. */
export function _resetDrafts() {
  drafts.clear();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/payment/build") {
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
        const { status, body: responseBody } = handleBuild({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    const submitMatch = req.url.match(/^\/payment\/submit\/([^/]+)$/);
    if (req.method === "POST" && submitMatch) {
      const draftId = decodeURIComponent(submitMatch[1]);
      const { status, body: responseBody } = handleSubmit({ draftId });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4057;
  server.listen(port, () => {
    console.log(
      `payment-build-submit mock listening on http://localhost:${port}/payment/build and /payment/submit/:draftId`,
    );
  });
}
