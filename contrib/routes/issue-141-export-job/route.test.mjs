import assert from "node:assert/strict";
import { handleSubmit, handlePoll, _resetJobs } from "./route.mjs";

_resetJobs();

// Submit: missing required field.
const missingAccount = handleSubmit({ body: {} });
assert.equal(missingAccount.status, 400);
assert.equal(missingAccount.body.error, "invalid_request");

// Submit: success, job starts pending.
const submitted = handleSubmit({ body: { accountId: "acct_demo", format: "csv" } });
assert.equal(submitted.status, 200);
assert.equal(submitted.body.status, "pending");
assert.ok(submitted.body.jobId.startsWith("export_"));

// Poll: unknown job id.
const unknownPoll = handlePoll({ jobId: "export_does_not_exist" });
assert.equal(unknownPoll.status, 404);
assert.equal(unknownPoll.body.error, "job_not_found");

// Poll repeatedly until the job reaches "complete", per the requirement
// that this takes a fixed number of calls (simulated async export).
const jobId = submitted.body.jobId;
let last;
let polls = 0;
do {
  last = handlePoll({ jobId });
  polls += 1;
  assert.ok(polls <= 10, "job did not complete within a reasonable number of polls");
} while (last.body.status !== "complete");

assert.equal(last.body.status, "complete");
assert.equal(polls, 3, "job should complete after exactly 3 polls");
assert.ok(last.body.downloadUrl.endsWith(".csv"));
assert.ok(last.body.completedAt);

// Polling again after completion stays complete (one-way transition) and
// keeps the same download url.
const afterComplete = handlePoll({ jobId });
assert.equal(afterComplete.body.status, "complete");
assert.equal(afterComplete.body.downloadUrl, last.body.downloadUrl);

console.log(`PASS: export job submitted, polled ${polls}x, resolved to complete with a download url`);
