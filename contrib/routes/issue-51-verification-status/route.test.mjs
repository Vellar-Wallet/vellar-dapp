import assert from "node:assert/strict";
import { handleRequest, STATUSES } from "./route.mjs";

// A known job id returns the job record with an allowed status.
const hit = handleRequest({ params: { jobId: "job_2002" } });
assert.equal(hit.status, 200);
assert.equal(hit.body.jobId, "job_2002");
assert.equal(hit.body.status, "verified");
assert.equal(hit.body.completedAt, "2025-03-03T14:47:31Z");

// Every sample job reports one of the three allowed statuses.
for (const jobId of ["job_2001", "job_2002", "job_2003"]) {
  const { status, body } = handleRequest({ params: { jobId } });
  assert.equal(status, 200);
  assert.ok(STATUSES.includes(body.status), `unexpected status: ${body.status}`);
  assert.equal(typeof body.submittedAt, "string");
}

// A pending job has no completion timestamp yet.
const pending = handleRequest({ params: { jobId: "job_2001" } });
assert.equal(pending.body.status, "pending");
assert.equal(pending.body.completedAt, null);

// An unknown job id returns a 404-style payload.
const miss = handleRequest({ params: { jobId: "job_9999" } });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");
assert.equal(miss.body.status, undefined);

// A missing job id is also treated as not found.
const noId = handleRequest({});
assert.equal(noId.status, 404);

console.log("PASS: /verification-jobs/:jobId returns job status on a hit and 404 on a miss");
