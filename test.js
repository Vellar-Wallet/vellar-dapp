const BASE_URL = "http://localhost:4500";

const matchingSubmission = {
  contractId: "C-MATCHING-123",
  repoUrl: "https://github.com/Vellar-Wallet/vellar-dapp",
  commitHash: "drips",
  toolchainVersion: "1.94.0",
  buildFlags: [],
};

const differingSubmission = {
  contractId: "C-DIFFERING-456",
  repoUrl: "https://github.com/Vellar-Wallet/vellar-dapp",
  commitHash: "main", // Different from reference
  toolchainVersion: "1.90.0", // Different from reference
  buildFlags: ["--release"], // Different from reference
};

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest(name, submission) {
  console.log(`\n--- Running Test: ${name} ---`);

  // 1. Submit
  console.log(`\n1. Submitting contract ${submission.contractId}...`);
  const submitRes = await fetch(`${BASE_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  const submitBody = await submitRes.json();
  console.log("   Response:", submitBody);
  if (submitRes.status !== 202) {
    throw new Error("Submission failed!");
  }

  // 2. Poll for status
  console.log("\n2. Polling for build status...");
  let status = "submitted";
  while (status !== "complete") {
    await sleep(500); // Wait before polling
    const statusRes = await fetch(`${BASE_URL}/status/${submission.contractId}`);
    const statusBody = await statusRes.json();
    status = statusBody.status;
    console.log(`   Polled status: ${status}`);
  }
  console.log("   Build complete!");

  // 3. Get diff
  console.log("\n3. Getting diff report...");
  const diffRes = await fetch(`${BASE_URL}/diff/${submission.contractId}`);
  const diffBody = await diffRes.json();

  if (diffBody.match) {
    console.log("   ✅ Result: Match found. The submission details match the reference.");
  } else {
    console.log("   ❌ Result: Mismatch found.");
    console.log("   Differing fields:");
    diffBody.diffs.forEach((d) => {
      console.log(`     - Field: ${d.field}`);
      console.log(`       Submitted: ${JSON.stringify(d.submitted)}`);
      console.log(`       Expected:  ${JSON.stringify(d.expected)}`);
    });
  }

  console.log(`--- Test Complete: ${name} ---\n`);
  return diffBody.match;
}

async function main() {
  try {
    // Check if server is up
    await fetch(BASE_URL);
  } catch (e) {
    console.error("Error: Could not connect to the server.");
    console.error("Please make sure the server is running with `node server.js` before running this test script.");
    process.exit(1);
  }

  try {
    const matchingResult = await runTest("Matching Submission", matchingSubmission);
    if (!matchingResult) throw new Error("Matching test case failed: expected a match.");

    const differingResult = await runTest("Differing Submission", differingSubmission);
    if (differingResult) throw new Error("Differing test case failed: expected a mismatch.");

    console.log("✅ All test scenarios passed successfully!");
  } catch (error) {
    console.error("\n❌ A test scenario failed:", error.message);
    process.exit(1);
  }
}

main();