const express = require("express");
const bodyParser = require("body-parser");

/**
 * =============================================================================
 *  Mock Data Store & Business Logic
 *  In a real application, this would live in separate files (e.g., a database
 *  service) and be properly modeled.
 * =============================================================================
 */

const STATUS = {
  PENDING: "pending",
  BUILDING: "building",
  COMPLETE: "complete",
  NOT_FOUND: "not_found",
};

const POLLS_UNTIL_COMPLETE = 2;

// In-memory store for submissions and their build state.
const submissionStore = new Map();

// A hardcoded reference contract for diffing against.
const referenceContract = {
  repoUrl: "https://github.com/Vellar-Wallet/vellar-dapp",
  commitHash: "drips",
  toolchainVersion: "1.94.0",
  buildFlags: [],
};

function createSubmission(contractId, details) {
  submissionStore.set(contractId, {
    details,
    pollCount: 0,
  });
}

function getSubmission(contractId) {
  return submissionStore.get(contractId)?.details;
}

function getSubmissionStatus(contractId) {
  const submission = submissionStore.get(contractId);
  if (!submission) {
    return STATUS.NOT_FOUND;
  }

  // Increment poll count for the simulation
  submission.pollCount += 1;

  return submission.pollCount <= POLLS_UNTIL_COMPLETE
    ? STATUS.BUILDING
    : STATUS.COMPLETE;
}

const app = express();
app.use(bodyParser.json());

/**
 * POST /submit
 *
 * Accepts a contract submission and stores it for status and diff checks.
 * The `contractId` from the body is used as the unique identifier.
 */
app.post("/submit", (req, res) => {
  const { contractId, ...details } = req.body;

  if (!contractId) {
    return res.status(400).json({ error: "contractId is required" });
  }

  createSubmission(contractId, details);
  console.log(`[Server] Received submission for contract: ${contractId}`);
  res.status(202).json({ status: STATUS.PENDING, contractId });
});

/**
 * GET /status/:contractId
 *
 * Simulates a build process. It transitions from "building" to "complete"
 * after a fixed number of polls (2 polls).
 */
app.get("/status/:contractId", (req, res) => {
  const { contractId } = req.params;

  const status = getSubmissionStatus(contractId);

  if (status === STATUS.NOT_FOUND) {
    return res.status(404).json({ error: "Contract not found" });
  }

  console.log(`[Server] Status check for ${contractId}: ${status}`);
  res.json({ status });
});

/**
 * GET /diff/:contractId
 *
 * Compares the submitted contract details against the reference contract.
 * Returns a boolean `match` and a list of differing fields if they don't match.
 */
app.get("/diff/:contractId", (req, res) => {
  const { contractId } = req.params;
  const submission = getSubmission(contractId);

  if (!submission) {
    return res.status(404).json({ error: "Contract not found" });
  }

  const diffs = [];
  for (const key of Object.keys(referenceContract)) {
    // Deep compare for arrays, simple compare for strings.
    const submittedValue = JSON.stringify(submission[key] ?? null);
    const referenceValue = JSON.stringify(referenceContract[key] ?? null);

    if (submittedValue !== referenceValue) {
      diffs.push({
        field: key,
        submitted: submission[key],
        expected: referenceContract[key],
      });
    }
  }

  const match = diffs.length === 0;
  console.log(`[Server] Diff check for ${contractId}: ${match ? "match" : "mismatch"}`);

  res.json({ match, diffs });
});

const PORT = 4500;
app.listen(PORT, () => {
  console.log(`Verification diff simulation server running on http://localhost:${PORT}`);
  console.log("Run `node test.js` in another terminal to test the endpoints.");
});