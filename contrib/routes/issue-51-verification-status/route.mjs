// Mock GET route returning the status of a sample verification job looked up by
// a job id path parameter. No chain or DB access.
import http from "node:http";

export const STATUSES = ["pending", "verified", "failed"];

const JOBS = {
  job_2001: {
    jobId: "job_2001",
    status: "pending",
    submittedAt: "2025-03-04T09:12:00Z",
    completedAt: null,
    message: "Build queued",
  },
  job_2002: {
    jobId: "job_2002",
    status: "verified",
    submittedAt: "2025-03-03T14:40:00Z",
    completedAt: "2025-03-03T14:47:31Z",
    message: "Wasm hash matches the published source",
  },
  job_2003: {
    jobId: "job_2003",
    status: "failed",
    submittedAt: "2025-03-02T18:05:10Z",
    completedAt: "2025-03-02T18:09:44Z",
    message: "Reproduced wasm hash did not match the on-chain hash",
  },
};

export function handleRequest({ params = {} } = {}) {
  const { jobId } = params;
  const job = jobId ? JOBS[jobId] : undefined;

  if (!job) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `No verification job found for id "${jobId ?? ""}"`,
      },
    };
  }

  return { status: 200, body: { ...job } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/verification-jobs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const { status, body } = handleRequest({
        params: { jobId: decodeURIComponent(match[1]) },
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4051;
  server.listen(port, () => {
    console.log(
      `verification-status mock listening on http://localhost:${port}/verification-jobs/:jobId`,
    );
  });
}
