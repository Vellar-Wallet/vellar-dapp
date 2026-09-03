import assert from "node:assert/strict";
import {
  submitVerification,
  getJob,
  runBuild,
  getDiff,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

const KNOWN_GOOD_HASH = "3e39e2294183941d80758367b1b8ecc4fbca4f8c2850003bcdfdd65d40bbb2b7";
const DRIFTED_REF_HASH = "fbafef48a67b35305da696d03730f8bd748ba518b9cacd15a7ac2c10f2491dbc";

// ---------------------------------------------------------------------------
// Submission: recorded, but nothing is built yet.
// ---------------------------------------------------------------------------
const submitted = submitVerification({
  contractId: "CONTRACT_KNOWN_GOOD",
  submittedHash: KNOWN_GOOD_HASH,
  source: "known-good source v1",
});
assert.equal(submitted.status, 202);
assert.equal(submitted.payload.status, "queued");
assert.equal(submitted.payload.build, null);
assert.equal(submitted.payload.diff, null);
assert.equal(submitted.payload.submittedHash, KNOWN_GOOD_HASH);

assert.equal(submitVerification({}).payload.field, "contractId");
assert.equal(submitVerification({ contractId: "x" }).payload.field, "submittedHash");
assert.equal(
  submitVerification({ contractId: "x", submittedHash: "not-hex!" }).payload.field,
  "submittedHash",
);
assert.equal(
  submitVerification({ contractId: "x", submittedHash: KNOWN_GOOD_HASH }).payload.field,
  "source",
);

assert.equal(getJob(submitted.payload.jobId).payload.status, "queued");
assert.equal(getJob("nope").status, 404);
assert.equal(getJob("").status, 400);

// ---------------------------------------------------------------------------
// A diff cannot be requested before a build has run.
// ---------------------------------------------------------------------------
let refused = getDiff(submitted.payload.jobId);
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "not_built");

// ---------------------------------------------------------------------------
// Build: deterministic hashing of the submitted source.
// ---------------------------------------------------------------------------
let built = runBuild(submitted.payload.jobId);
assert.equal(built.status, 200);
assert.equal(built.payload.status, "built");
assert.equal(built.payload.build.hash, KNOWN_GOOD_HASH);
assert.ok(built.payload.build.builtAt);

// A build cannot be re-run once it has already run.
refused = runBuild(submitted.payload.jobId);
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "already_built");

assert.equal(runBuild("nope").status, 404);

// ---------------------------------------------------------------------------
// Diff: submitted hash matches build, and build matches the reference on
// file for this contract id.
// ---------------------------------------------------------------------------
let diffed = getDiff(submitted.payload.jobId);
assert.equal(diffed.status, 200);
assert.equal(diffed.payload.status, "diffed");
assert.equal(diffed.payload.diff.submittedMatchesBuild, true);
assert.equal(diffed.payload.diff.referenceHash, KNOWN_GOOD_HASH);
assert.equal(diffed.payload.diff.referenceMatch, true);

// Requesting the diff again reports the same result (idempotent read).
assert.deepEqual(getDiff(submitted.payload.jobId).payload.diff, diffed.payload.diff);

// ---------------------------------------------------------------------------
// A contract with a reference hash on file that has since drifted: the build
// still succeeds (it only hashes what was submitted), but the diff reports a
// mismatch against the registry.
// ---------------------------------------------------------------------------
const drifted = submitVerification({
  contractId: "CONTRACT_DRIFTED",
  submittedHash: "aaaaaaaa",
  source: "a patched source that differs from the reference",
});
runBuild(drifted.payload.jobId);
diffed = getDiff(drifted.payload.jobId);
assert.equal(diffed.payload.diff.referenceHash, DRIFTED_REF_HASH);
assert.equal(diffed.payload.diff.referenceMatch, false);
// The submitted hash was also a lie -- it doesn't match what was built either.
assert.equal(diffed.payload.diff.submittedMatchesBuild, false);

// ---------------------------------------------------------------------------
// A contract id with no reference hash on file: not an error, just nothing
// to compare against.
// ---------------------------------------------------------------------------
const novel = submitVerification({
  contractId: "CONTRACT_BRAND_NEW",
  submittedHash: "bbbbbbbb",
  source: "a contract nobody has registered a reference for",
});
runBuild(novel.payload.jobId);
diffed = getDiff(novel.payload.jobId);
assert.equal(diffed.payload.diff.referenceHash, null);
assert.equal(diffed.payload.diff.referenceMatch, null);

// ---------------------------------------------------------------------------
// Build hashing normalises whitespace, the way a real compiler's lexer
// would, so formatting alone never manufactures a mismatch.
// ---------------------------------------------------------------------------
const messy = submitVerification({
  contractId: "CONTRACT_KNOWN_GOOD",
  submittedHash: KNOWN_GOOD_HASH,
  source: "  known-good   source\nv1  ",
});
runBuild(messy.payload.jobId);
assert.equal(getDiff(messy.payload.jobId).payload.diff.buildHash, KNOWN_GOOD_HASH);

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------
const routed = handleRequest("POST", "/verify", {
  contractId: "CONTRACT_ROUTED",
  submittedHash: "cccccccc",
  source: "routed source",
});
assert.equal(routed.status, 202);
assert.equal(handleRequest("GET", `/verify/${routed.payload.jobId}`).status, 200);
assert.equal(handleRequest("POST", `/verify/${routed.payload.jobId}/build`).status, 200);
assert.equal(handleRequest("GET", `/verify/${routed.payload.jobId}/diff`).status, 200);
assert.equal(handleRequest("GET", "/verify/nope").status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

// resetState clears every job.
resetState();
assert.equal(getJob(routed.payload.jobId).status, 404);

console.log(
  "PASS: verification jobs move queued -> built -> diffed, comparing submitted, build, and reference hashes independently",
);
