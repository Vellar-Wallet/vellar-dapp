import http from "node:http";
import { URL, pathToFileURL } from "node:url";

const proposals = new Map();
let nextProposalId = 1;

function error(status, code, message) {
  return { status, body: { error: code, message } };
}

function propose(body = {}) {
  const { transaction, signers, threshold } = body;
  if (!transaction || !Array.isArray(signers) || signers.length === 0) {
    return error(400, "invalid_proposal", "transaction and a non-empty signers array are required");
  }
  if (
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > signers.length ||
    new Set(signers).size !== signers.length ||
    signers.some((signer) => typeof signer !== "string" || signer === "")
  ) {
    return error(400, "invalid_threshold", "threshold must be between 1 and the number of unique signers");
  }

  const id = `prop_${String(nextProposalId++).padStart(3, "0")}`;
  proposals.set(id, {
    id,
    transaction,
    signers: [...signers],
    threshold,
    approvals: new Set(),
  });

  return {
    status: 201,
    body: { proposalId: id, transaction, signers: [...signers], threshold, approvals: [], status: "pending" },
  };
}

function approve(body = {}) {
  const { proposalId, signer } = body;
  const proposal = proposals.get(proposalId);
  if (!proposal) return error(404, "proposal_not_found", `proposal ${proposalId ?? ""} was not found`);
  if (typeof signer !== "string" || signer === "") {
    return error(400, "invalid_signer", "signer is required");
  }
  if (!proposal.signers.includes(signer)) {
    return error(403, "signer_not_allowed", `signer ${signer} is not allowed for this proposal`);
  }
  if (proposal.approvals.has(signer)) {
    return error(409, "duplicate_approval", `signer ${signer} has already approved this proposal`);
  }

  proposal.approvals.add(signer);
  return approvalStatus(proposal, 200);
}

function approvalStatus(proposal, status = 200) {
  const approvals = [...proposal.approvals];
  return {
    status,
    body: {
      proposalId: proposal.id,
      transaction: proposal.transaction,
      approvals,
      approvalCount: approvals.length,
      threshold: proposal.threshold,
      status: approvals.length >= proposal.threshold ? "ready" : "pending",
    },
  };
}

function status(query = {}) {
  const proposal = proposals.get(query.proposalId);
  if (!proposal) return error(404, "proposal_not_found", `proposal ${query.proposalId ?? ""} was not found`);
  return approvalStatus(proposal);
}

export function resetState() {
  proposals.clear();
  nextProposalId = 1;
}

export function handleRequest({ method = "GET", path = "", body = {}, query = {} } = {}) {
  if (path === "/propose") {
    return method === "POST" ? propose(body) : error(405, "method_not_allowed", "POST is required");
  }
  if (path === "/approve") {
    return method === "POST" ? approve(body) : error(405, "method_not_allowed", "POST is required");
  }
  if (path === "/status") {
    return method === "GET" ? status(query) : error(405, "method_not_allowed", "GET is required");
  }
  return error(404, "not_found", "route not found");
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry !== null && import.meta.url === entry) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result = body === null
      ? error(400, "invalid_json", "request body must be valid JSON")
      : handleRequest({ method: req.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4108;
  server.listen(port, () => console.log(`multisig approval suite listening on http://localhost:${port}`));
}