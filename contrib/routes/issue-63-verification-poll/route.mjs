// Mock route module simulating contract verification submission and
// polling. POST /verification/submit starts a pending job; GET
// /verification/status/:jobId transitions it to "verified" after a fixed
// number of polls, to simulate a slow off-chain verification process. No
// chain or DB access.
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

// The job flips from "pending" to "verified" once it has been polled this
// many times (inclusive of the poll that crosses the threshold).
const POLLS_UNTIL_VERIFIED = 3;

// In-memory job store, keyed by jobId. Cleared on process restart.
const jobs = new Map();

function makeJobId() {
  return `job_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Submits a contract for mock verification.
 * @param {{body?: object}} input
 */
export function handleSubmit({ body = {} } = {}) {
  if (!body.contractAddress) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "Missing required field: contractAddress",
      },
    };
  }

  const jobId = makeJobId();
  jobs.set(jobId, {
    jobId,
    contractAddress: body.contractAddress,
    status: "pending",
    pollCount: 0,
    createdAt: new Date().toISOString(),
  });

  return {
    status: 200,
    body: { jobId, status: "pending" },
  };
}

/**
 * Polls a verification job. Each call to a still-pending job increments
 * its internal poll counter; once the counter reaches
 * POLLS_UNTIL_VERIFIED, the job transitions to "verified" and stays there
 * for every subsequent poll (the transition is one-way).
 * @param {{jobId?: string}} input
 */
export function handlePoll({ jobId } = {}) {
  const job = jobs.get(jobId);

  if (!job) {
    return {
      status: 404,
      body: {
        error: "job_not_found",
        message: `No verification job found for jobId "${jobId}"`,
      },
    };
  }

  if (job.status === "pending") {
    job.pollCount += 1;
    if (job.pollCount >= POLLS_UNTIL_VERIFIED) {
      job.status = "verified";
      job.verifiedAt = new Date().toISOString();
    }
  }

  return {
    status: 200,
    body: {
      jobId: job.jobId,
      status: job.status,
      pollCount: job.pollCount,
      ...(job.status === "verified" ? { verifiedAt: job.verifiedAt } : {}),
    },
  };
}

/** Test-only helper to reset in-memory state between test files/runs. */
export function _resetJobs() {
  jobs.clear();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/verification/submit") {
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
        const { status, body: responseBody } = handleSubmit({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const pollMatch = url.pathname.match(/^\/verification\/status\/([^/]+)$/);
    if (req.method === "GET" && pollMatch) {
      const jobId = decodeURIComponent(pollMatch[1]);
      const { status, body } = handlePoll({ jobId });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4063;
  server.listen(port, () => {
    console.log(
      `verification-poll mock listening on http://localhost:${port}/verification/submit and /verification/status/:jobId`,
    );
  });
}
