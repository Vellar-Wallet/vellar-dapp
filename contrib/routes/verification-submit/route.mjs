// Mock POST route accepting a contract verification submission. No chain,
// queue or database access — the job id comes from an in-process counter.
import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

let jobCounter = 0;

/** Resets the id counter. Only used by the test script so each run is
 * deterministic regardless of test order. */
export function resetJobCounter() {
  jobCounter = 0;
}

/** Generates the next job id, e.g. `vjob_000001`. Sequential rather than
 * random so responses are reproducible in tests and local dev. */
function nextJobId() {
  jobCounter += 1;
  return `vjob_${String(jobCounter).padStart(6, "0")}`;
}

/**
 * Validates the submission body and, on success, produces the queued job.
 * Exported separately from the HTTP plumbing so it can be tested directly.
 */
export function submitVerification(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_body" } };
  }
  if (!("contractId" in body)) {
    return { status: 400, body: { error: "contract_id_required" } };
  }
  if (typeof body.contractId !== "string" || body.contractId.trim() === "") {
    return { status: 400, body: { error: "invalid_contract_id" } };
  }

  return {
    status: 202,
    body: {
      jobId: nextJobId(),
      contractId: body.contractId.trim(),
      status: "queued",
    },
  };
}

/** Collects the request body, rejecting anything larger than MAX_BODY_BYTES
 * so a runaway client can't grow the buffer without bound. */
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        tooLarge = true;
      }
    });
    req.on("end", () => resolve(tooLarge ? { tooLarge: true } : { raw: data }));
  });
}

export async function handleRequest(req) {
  const path = new URL(req.url, "http://localhost").pathname;

  if (path !== "/verification/submit") {
    return { status: 404, body: { error: "not_found" } };
  }
  if (req.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  const { raw, tooLarge } = await readBody(req);
  if (tooLarge) {
    return { status: 413, body: { error: "body_too_large" } };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw === "" ? "null" : raw);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  return submitVerification(parsed);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const { status, body } = await handleRequest(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4054;
  server.listen(port, () => {
    console.log(
      `verification-submit mock listening on http://localhost:${port}/verification/submit`,
    );
  });
}
