import assert from "node:assert/strict";
import { handleSubmit, handlePoll, _resetJobs } from "./route.mjs";

_resetJobs();

// Submit: missing required field.
const missingAddress = handleSubmit({ body: {} });
assert.equal(missingAddress.status, 400);
assert.equal(missingAddress.body.error, "invalid_request");

// Submit: success, job starts pending.
const submitted = handleSubmit({
  body: { contractAddress: "CABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH" },
});
assert.equal(submitted.status, 200);
assert.equal(submitted.body.status, "pending");
assert.ok(submitted.body.jobId.startsWith("job_"));

// Poll: unknown job id.
const unknownPoll = handlePoll({ jobId: "job_does_not_exist" });
assert.equal(unknownPoll.status, 404);
assert.equal(unknownPoll.body.error, "job_not_found");

// Poll repeatedly until the job resolves to "verified", per the
// requirement that this takes a fixed number of calls (simulated delay).
const jobId = submitted.body.jobId;
let last;
let polls = 0;
do {
  last = handlePoll({ jobId });
  polls += 1;
  assert.ok(polls <= 10, "job did not verify within a reasonable number of polls");
} while (last.body.status !== "verified");

assert.equal(last.body.status, "verified");
assert.equal(polls, 3, "job should verify after exactly 3 polls");
assert.ok(last.body.verifiedAt);

// Polling again after verification stays verified (one-way transition)
// and keeps the same verifiedAt timestamp.
const afterVerified = handlePoll({ jobId });
assert.equal(afterVerified.body.status, "verified");
assert.equal(afterVerified.body.verifiedAt, last.body.verifiedAt);

console.log(`PASS: verification job submitted, polled ${polls}x, resolved to verified`);
