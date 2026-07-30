const express = require("express");
const bodyParser = require("body-parser");

// In-memory store for submissions and status poll tracking.
// In a real app, this would be a database.
const submissions = new Map();
const pollCounts = new Map();

// A hardcoded reference contract for diffing against.
const referenceContract = {
  repoUrl: "https://github.com/Vellar-Wallet/vellar-dapp",
  commitHash: "drips",
  toolchainVersion: "1.94.0",
  buildFlags: [],
};

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

  submissions.set(contractId, details);
  pollCounts.set(contractId, 0); // Initialize poll count

  console.log(`[Server] Received submission for contract: ${contractId}`);
  res.status(202).json({ status: "submitted", contractId });
});

/**
 * GET /status/:contractId
 *
 * Simulates a build process. It transitions from "building" to "complete"
 * after a fixed number of polls (2 polls).
 */
app.get("/status/:contractId", (req, res) => {
  const { contractId } = req.params;

  if (!submissions.has(contractId)) {
    return res.status(404).json({ error: "Contract not found" });
  }

  const count = pollCounts.get(contractId) ?? 0;
  pollCounts.set(contractId, count + 1);

  // Transition to 'complete' after 2 polls.
  const status = count < 2 ? "building" : "complete";

  console.log(`[Server] Status check for ${contractId}: ${status} (poll #${count + 1})`);
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
  const submission = submissions.get(contractId);

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