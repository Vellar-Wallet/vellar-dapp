// Mock export job queue: jobs are enqueued with an output format and drained
// strictly first-in-first-out, one at a time. Everything lives in process
// memory — no worker, no storage, no chain access.
import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE_LENGTH = 100;

/** The only output formats an export job may request. */
export const ALLOWED_FORMATS = ["csv", "json"];

const CONTENT_TYPES = { csv: "text/csv", json: "application/json" };

/** Queue state. `processing` holds the single in-flight job id, which is what
 * makes this one-at-a-time: a job is only promoted out of `queued` once the
 * previous one has completed. */
let jobs = new Map();
let queued = [];
let processing = null;
let completed = [];
let jobCounter = 0;

/** Resets all queue state. Used by the test script so runs are deterministic. */
export function resetQueue() {
  jobs = new Map();
  queued = [];
  processing = null;
  completed = [];
  jobCounter = 0;
}

function nextJobId() {
  jobCounter += 1;
  return `exp_${String(jobCounter).padStart(4, "0")}`;
}

/** Promotes the head of the queue into the processing slot, if it is free. */
function promoteNext() {
  if (processing !== null || queued.length === 0) {
    return;
  }
  processing = queued.shift();
  jobs.get(processing).status = "processing";
}

function serialize(jobId) {
  const job = jobs.get(jobId);
  const view = {
    jobId: job.jobId,
    format: job.format,
    resource: job.resource,
    status: job.status,
    sequence: job.sequence,
  };
  if (job.status === "queued") {
    view.position = queued.indexOf(jobId) + 1;
  }
  if (job.artifact) {
    view.artifact = { ...job.artifact };
  }
  return view;
}

/**
 * Validates the enqueue payload and appends the job. The first job enqueued
 * into an idle queue starts processing immediately; later ones wait behind it.
 */
export function enqueue(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_body" } };
  }
  if (!("format" in body)) {
    return {
      status: 400,
      body: { error: "format_required", allowedFormats: ALLOWED_FORMATS },
    };
  }
  if (typeof body.format !== "string") {
    return {
      status: 400,
      body: { error: "invalid_format", allowedFormats: ALLOWED_FORMATS },
    };
  }

  const format = body.format.trim().toLowerCase();
  if (!ALLOWED_FORMATS.includes(format)) {
    return {
      status: 400,
      body: {
        error: "unsupported_format",
        format: body.format,
        allowedFormats: ALLOWED_FORMATS,
      },
    };
  }

  if (body.resource !== undefined && typeof body.resource !== "string") {
    return { status: 400, body: { error: "invalid_resource" } };
  }
  if (queued.length + (processing === null ? 0 : 1) >= MAX_QUEUE_LENGTH) {
    return {
      status: 429,
      body: { error: "queue_full", maxQueueLength: MAX_QUEUE_LENGTH },
    };
  }

  const jobId = nextJobId();
  jobs.set(jobId, {
    jobId,
    format,
    resource: body.resource ?? "transactions",
    status: "queued",
    sequence: jobCounter,
    artifact: null,
  });
  queued.push(jobId);
  promoteNext();

  return { status: 202, body: serialize(jobId) };
}

/**
 * Completes the in-flight job and promotes the next one. Draining is driven
 * explicitly rather than by a timer so the FIFO order is observable and
 * testable without waiting on the clock.
 */
export function processNext() {
  if (processing === null) {
    return { status: 409, body: { error: "queue_idle" } };
  }

  const jobId = processing;
  const job = jobs.get(jobId);
  job.status = "completed";
  job.artifact = {
    filename: `${job.resource}-${jobId}.${job.format}`,
    contentType: CONTENT_TYPES[job.format],
  };
  completed.push(jobId);
  processing = null;
  promoteNext();

  return {
    status: 200,
    body: { completed: serialize(jobId), nowProcessing: processing ? serialize(processing) : null },
  };
}

/** Snapshot of the queue: what is in flight, what is waiting (in order), and
 * what has finished (in completion order). */
export function queueStatus() {
  return {
    status: 200,
    body: {
      processing: processing ? serialize(processing) : null,
      queued: queued.map(serialize),
      completed: completed.map(serialize),
      counts: {
        processing: processing ? 1 : 0,
        queued: queued.length,
        completed: completed.length,
        total: jobs.size,
      },
      allowedFormats: ALLOWED_FORMATS,
    },
  };
}

/** Single job lookup, so a client that holds a job id can poll just that one. */
export function getJob(jobId) {
  if (!jobs.has(jobId)) {
    return { status: 404, body: { error: "job_not_found", jobId } };
  }
  return { status: 200, body: serialize(jobId) };
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

async function readJson(req) {
  const { raw, tooLarge } = await readBody(req);
  if (tooLarge) {
    return { error: { status: 413, body: { error: "body_too_large" } } };
  }
  try {
    return { value: JSON.parse(raw === "" ? "null" : raw) };
  } catch {
    return { error: { status: 400, body: { error: "invalid_json" } } };
  }
}

export async function handleRequest(req) {
  const path = new URL(req.url, "http://localhost").pathname;

  if (path === "/export/enqueue") {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    const { value, error } = await readJson(req);
    if (error) return error;
    return enqueue(value);
  }

  if (path === "/export/process") {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    return processNext();
  }

  if (path === "/export/queue-status") {
    if (req.method !== "GET") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    return queueStatus();
  }

  const job = /^\/export\/jobs\/([^/]+)$/.exec(path);
  if (job) {
    if (req.method !== "GET") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    return getJob(decodeURIComponent(job[1]));
  }

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const { status, body } = await handleRequest(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4056;
  server.listen(port, () => {
    console.log(`export-queue-suite mock listening on http://localhost:${port}`);
    console.log(`  POST /export/enqueue`);
    console.log(`  POST /export/process`);
    console.log(`  GET  /export/queue-status`);
    console.log(`  GET  /export/jobs/:jobId`);
  });
}
