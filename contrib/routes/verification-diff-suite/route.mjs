import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Verification Submission and Status Diff (Issue #94)
 *
 * A contract verification moves through three stages:
 *
 *   1. Submit (`POST /verify`) -- accept a contract id, a submitted hash, and
 *      the source the caller claims produces it. Queued, nothing built yet.
 *   2. Build (`POST /verify/:jobId/build`) -- run a mock build over the
 *      submitted source and produce a build hash. Deterministic: the same
 *      source always builds to the same hash, so re-running a build never
 *      changes the answer.
 *   3. Diff (`GET /verify/:jobId/diff`) -- compare the build hash against the
 *      reference hash on file for the contract id and report match/mismatch.
 *      Available only once a build has run.
 *
 * There is no real compiler here: the "build" is a deterministic hash of the
 * normalised source text, standing in for reproducible output. Everything is
 * in memory; no chain, registry, or filesystem is touched.
 */

/**
 * Stand-in reference hashes, as if pulled from an on-chain registry. Keyed by
 * contractId. A contract id with no entry has nothing to diff against, which
 * is itself a reportable outcome rather than an error.
 */
const REFERENCE_HASHES = {
  CONTRACT_KNOWN_GOOD: hashSource(sourceOf("known-good source v1")),
  CONTRACT_DRIFTED: hashSource(sourceOf("reference source, pre-patch")),
};

function sourceOf(seed) {
  return seed;
}

/**
 * The mock build. Whitespace is normalised before hashing so that formatting
 * differences (trailing spaces, a stray blank line) don't manufacture a
 * mismatch the way a real compiler's lexer would also ignore them.
 */
function hashSource(source) {
  const normalised = source.replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

/** jobId -> record */
const jobs = new Map();
let jobCounter = 0;

/** Clears every stored job and resets the id counter. Exported for tests. */
export function resetState() {
  jobs.clear();
  jobCounter = 0;
}

function nextJobId() {
  jobCounter += 1;
  return `vjob_${String(jobCounter).padStart(6, "0")}`;
}

function badRequest(payload) {
  return { status: 400, payload: { error: "invalid_request", ...payload } };
}

function notFound(jobId) {
  return { status: 404, payload: { error: "job_not_found", requested: jobId ?? null } };
}

function viewOf(record) {
  return {
    jobId: record.jobId,
    contractId: record.contractId,
    submittedHash: record.submittedHash,
    status: record.status,
    build: record.build ? { ...record.build } : null,
    diff: record.diff ? { ...record.diff } : null,
    submittedAt: record.submittedAt,
  };
}

/**
 * `POST /verify` -- submit a contract for verification.
 *
 * `submittedHash` is the hash the caller claims their source produces; it is
 * recorded but not checked against anything yet -- that only happens once a
 * build has actually run and produced its own hash independently.
 */
export function submitVerification({ contractId, submittedHash, source } = {}) {
  if (typeof contractId !== "string" || contractId.trim() === "") {
    return badRequest({ field: "contractId", reason: "must be a non-empty string" });
  }
  if (typeof submittedHash !== "string" || !/^[0-9a-f]{8,64}$/i.test(submittedHash)) {
    return badRequest({
      field: "submittedHash",
      reason: "must be a hex string between 8 and 64 characters",
    });
  }
  if (typeof source !== "string" || source.trim() === "") {
    return badRequest({ field: "source", reason: "must be a non-empty string" });
  }

  const now = new Date().toISOString();
  const record = {
    jobId: nextJobId(),
    contractId: contractId.trim(),
    submittedHash: submittedHash.toLowerCase(),
    source,
    status: "queued",
    build: null,
    diff: null,
    submittedAt: now,
  };
  jobs.set(record.jobId, record);
  return { status: 202, payload: viewOf(record) };
}

/** `GET /verify/:jobId` -- read back a job's current stage. */
export function getJob(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    return badRequest({ field: "jobId", reason: "must be a non-empty job id" });
  }
  const record = jobs.get(jobId);
  if (!record) return notFound(jobId);
  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /verify/:jobId/build` -- run the mock build.
 *
 * Refuses to re-build a job that has already built. A build is meant to be a
 * one-shot, reproducible step in this suite; re-running it would only ever
 * produce the same hash from the same source, so a second call is treated as
 * a caller mistake rather than silently re-running.
 */
export function runBuild(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    return badRequest({ field: "jobId", reason: "must be a non-empty job id" });
  }
  const record = jobs.get(jobId);
  if (!record) return notFound(jobId);

  if (record.status !== "queued") {
    return {
      status: 409,
      payload: { error: "already_built", jobId: record.jobId, status: record.status },
    };
  }

  const buildHash = hashSource(record.source);
  record.build = { hash: buildHash, builtAt: new Date().toISOString() };
  record.status = "built";

  return { status: 200, payload: viewOf(record) };
}

/**
 * `GET /verify/:jobId/diff` -- compare the build hash against the reference
 * hash on file for this contract id, and separately note whether the
 * submitted hash matched what actually got built.
 *
 * A contract id with no reference hash on file is not an error: it reports
 * `reference: null` and `referenceMatch: null` rather than failing, since
 * "nothing to compare against" is itself useful information for a caller
 * verifying a brand new contract.
 */
export function getDiff(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    return badRequest({ field: "jobId", reason: "must be a non-empty job id" });
  }
  const record = jobs.get(jobId);
  if (!record) return notFound(jobId);

  if (!record.build) {
    return {
      status: 409,
      payload: { error: "not_built", jobId: record.jobId, status: record.status },
    };
  }

  const reference = Object.prototype.hasOwnProperty.call(REFERENCE_HASHES, record.contractId)
    ? REFERENCE_HASHES[record.contractId]
    : null;

  const diff = {
    submittedHash: record.submittedHash,
    buildHash: record.build.hash,
    referenceHash: reference,
    submittedMatchesBuild: record.submittedHash === record.build.hash,
    referenceMatch: reference === null ? null : reference === record.build.hash,
  };

  record.diff = diff;
  record.status = "diffed";

  return { status: 200, payload: viewOf(record) };
}

export function handleRequest(method, pathname, body) {
  if (method === "POST" && pathname === "/verify") return submitVerification(body ?? {});

  const buildMatch = pathname.match(/^\/verify\/([^/]+)\/build$/);
  if (method === "POST" && buildMatch) return runBuild(decodeURIComponent(buildMatch[1]));

  const diffMatch = pathname.match(/^\/verify\/([^/]+)\/diff$/);
  if (method === "GET" && diffMatch) return getDiff(decodeURIComponent(diffMatch[1]));

  const getMatch = pathname.match(/^\/verify\/([^/]+)$/);
  if (method === "GET" && getMatch) return getJob(decodeURIComponent(getMatch[1]));

  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4094;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const { status, payload } = handleRequest(req.method, url.pathname, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(PORT, () => {
    console.log(`verification-diff-suite mock listening on http://localhost:${PORT}/verify`);
  });
}
