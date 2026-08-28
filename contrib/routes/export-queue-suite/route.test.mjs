import assert from "node:assert/strict";
import { handleRequest, resetQueue } from "./route.mjs";

/** Minimal stand-in for an http.IncomingMessage carrying a JSON body. */
function makeReq(method, url, body) {
  return {
    url,
    method,
    on: (event, cb) => {
      if (event === "data" && body !== undefined) cb(JSON.stringify(body));
      if (event === "end") cb();
    },
  };
}

const enqueueJob = (body) => handleRequest(makeReq("POST", "/export/enqueue", body));
const processNextJob = () => handleRequest(makeReq("POST", "/export/process"));
const status = () => handleRequest(makeReq("GET", "/export/queue-status"));

// --- two queued jobs are processed in the order they were enqueued ---------
{
  resetQueue();

  const first = await enqueueJob({ format: "csv", resource: "transactions" });
  const second = await enqueueJob({ format: "json", resource: "balances" });

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);

  // The first job took the single processing slot; the second waits behind it.
  assert.equal(first.body.status, "processing");
  assert.equal(second.body.status, "queued");
  assert.equal(second.body.position, 1);

  const beforeDraining = await status();
  assert.equal(beforeDraining.body.processing.jobId, first.body.jobId);
  assert.deepEqual(
    beforeDraining.body.queued.map((j) => j.jobId),
    [second.body.jobId],
  );
  assert.deepEqual(beforeDraining.body.counts, {
    processing: 1,
    queued: 1,
    completed: 0,
    total: 2,
  });

  // Draining once completes the first job and promotes the second.
  const firstDrain = await processNextJob();
  assert.equal(firstDrain.status, 200);
  assert.equal(firstDrain.body.completed.jobId, first.body.jobId);
  assert.equal(firstDrain.body.completed.status, "completed");
  assert.equal(firstDrain.body.completed.artifact.filename, `transactions-${first.body.jobId}.csv`);
  assert.equal(firstDrain.body.completed.artifact.contentType, "text/csv");
  assert.equal(firstDrain.body.nowProcessing.jobId, second.body.jobId);

  const secondDrain = await processNextJob();
  assert.equal(secondDrain.body.completed.jobId, second.body.jobId);
  assert.equal(secondDrain.body.completed.artifact.filename, `balances-${second.body.jobId}.json`);
  assert.equal(secondDrain.body.completed.artifact.contentType, "application/json");
  assert.equal(secondDrain.body.nowProcessing, null);

  // Completion order matches enqueue order — the FIFO guarantee.
  const drained = await status();
  assert.deepEqual(
    drained.body.completed.map((j) => j.jobId),
    [first.body.jobId, second.body.jobId],
  );
  assert.equal(drained.body.processing, null);
  assert.equal(drained.body.queued.length, 0);
}

// --- queue positions shift as the queue drains -----------------------------
{
  resetQueue();

  const a = await enqueueJob({ format: "csv" });
  const b = await enqueueJob({ format: "json" });
  const c = await enqueueJob({ format: "csv" });

  assert.equal(b.body.position, 1);
  assert.equal(c.body.position, 2);

  await processNextJob(); // completes a, promotes b

  const afterOne = await status();
  assert.equal(afterOne.body.processing.jobId, b.body.jobId);
  assert.equal(afterOne.body.queued[0].jobId, c.body.jobId);
  assert.equal(afterOne.body.queued[0].position, 1);
}

// --- format validation -----------------------------------------------------
{
  resetQueue();

  const missing = await enqueueJob({ resource: "transactions" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "format_required");
  assert.deepEqual(missing.body.allowedFormats, ["csv", "json"]);

  const unsupported = await enqueueJob({ format: "xlsx" });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error, "unsupported_format");
  assert.equal(unsupported.body.format, "xlsx");

  const wrongType = await enqueueJob({ format: 7 });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error, "invalid_format");

  const badResource = await enqueueJob({ format: "csv", resource: 12 });
  assert.equal(badResource.status, 400);
  assert.equal(badResource.body.error, "invalid_resource");

  // Rejected submissions never enter the queue.
  const afterRejections = await status();
  assert.equal(afterRejections.body.counts.total, 0);

  // Format matching is case- and whitespace-insensitive, and normalized.
  const normalized = await enqueueJob({ format: " CSV " });
  assert.equal(normalized.status, 202);
  assert.equal(normalized.body.format, "csv");
}

// --- job lookup and idle/guard cases ---------------------------------------
{
  resetQueue();

  const job = await enqueueJob({ format: "json" });
  const lookup = await handleRequest(makeReq("GET", `/export/jobs/${job.body.jobId}`));
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.jobId, job.body.jobId);

  const unknown = await handleRequest(makeReq("GET", "/export/jobs/exp_9999"));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "job_not_found");

  await processNextJob();
  const idle = await processNextJob();
  assert.equal(idle.status, 409);
  assert.equal(idle.body.error, "queue_idle");

  const wrongMethod = await handleRequest(makeReq("GET", "/export/enqueue"));
  assert.equal(wrongMethod.status, 405);

  const badJson = await handleRequest({
    url: "/export/enqueue",
    method: "POST",
    on: (event, cb) => {
      if (event === "data") cb("{not json");
      if (event === "end") cb();
    },
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error, "invalid_json");

  const unknownPath = await handleRequest(makeReq("GET", "/nope"));
  assert.equal(unknownPath.status, 404);
}

console.log("PASS: export queue enqueues, validates formats and drains FIFO one at a time");
