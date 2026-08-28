// Mock route module simulating a data export job. POST /export/submit
// starts a pending job; GET /export/status/:jobId transitions it to
// "complete" after a fixed number of polls, to simulate an
// asynchronous export process, then returns a mock download url. No
// chain or DB access.
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

// The job flips from "pending" to "complete" once it has been polled this
// many times (inclusive of the poll that crosses the threshold).
const POLLS_UNTIL_COMPLETE = 3;

// In-memory job store, keyed by jobId. Cleared on process restart.
const jobs = new Map();

function makeJobId() {
  return `export_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Submits a data export job.
 * @param {{body?: object}} input
 */
export function handleSubmit({ body = {} } = {}) {
  if (!body.accountId) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "Missing required field: accountId",
      },
    };
  }

  const jobId = makeJobId();
  jobs.set(jobId, {
    jobId,
    accountId: body.accountId,
    format: body.format || "csv",
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
 * Polls an export job. Each call to a still-pending job increments its
 * internal poll counter; once the counter reaches POLLS_UNTIL_COMPLETE,
 * the job transitions to "complete" and stays there for every subsequent
 * poll (the transition is one-way), returning a mock download url.
 * @param {{jobId?: string}} input
 */
export function handlePoll({ jobId } = {}) {
  const job = jobs.get(jobId);

  if (!job) {
    return {
      status: 404,
      body: {
        error: "job_not_found",
        message: `No export job found for jobId "${jobId}"`,
      },
    };
  }

  if (job.status === "pending") {
    job.pollCount += 1;
    if (job.pollCount >= POLLS_UNTIL_COMPLETE) {
      job.status = "complete";
      job.completedAt = new Date().toISOString();
      job.downloadUrl = `https://mock-exports.example.com/downloads/${job.jobId}.${job.format}`;
    }
  }

  return {
    status: 200,
    body: {
      jobId: job.jobId,
      status: job.status,
      pollCount: job.pollCount,
      ...(job.status === "complete"
        ? { completedAt: job.completedAt, downloadUrl: job.downloadUrl }
        : {}),
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
    if (req.method === "POST" && req.url === "/export/submit") {
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
    const pollMatch = url.pathname.match(/^\/export\/status\/([^/]+)$/);
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
  const port = process.env.PORT || 4141;
  server.listen(port, () => {
    console.log(
      `export-job mock listening on http://localhost:${port}/export/submit and /export/status/:jobId`,
    );
  });
}
