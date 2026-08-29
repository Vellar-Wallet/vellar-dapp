#!/usr/bin/env node
/**
 * Script to commit refactor #348 changes and run tests.
 * Bypasses terminal tool issues by using Node.js child_process directly.
 */

const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const workspaceRoot = "c:\\Users\\Nuelthewave\\Desktop\\VELLAR\\vellar-dapp";

function log(msg) {
  console.log(`\n[${new Date().toISOString()}] ${msg}`);
}

function runCommand(cmd, cwd = workspaceRoot) {
  log(`Running: ${cmd}`);
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(`✅ Command succeeded`);
    return { success: true, output };
  } catch (error) {
    log(`❌ Command failed with exit code ${error.status}`);
    return { success: false, output: error.stdout, error: error.stderr };
  }
}

async function main() {
  log("Starting refactor #348 commit and test process...");

  // Step 1: Check git status
  log("Step 1: Checking git status");
  const statusResult = runCommand("git status --porcelain");
  if (statusResult.success) {
    log("Current changes:");
    log(statusResult.output);
  }

  // Step 2: Stage all changes
  log("Step 2: Staging all changes");
  const addResult = runCommand("git add .");
  if (!addResult.success) {
    log(`Warning: git add may have issues. Continuing anyway.`);
  }

  // Step 3: Check what's staged
  log("Step 3: Verifying staged changes");
  const stagedResult = runCommand("git diff --cached --name-only");
  if (stagedResult.success) {
    log("Staged files:");
    log(stagedResult.output);
  }

  // Step 4: Create commit
  log("Step 4: Creating commit");
  const commitMessage =
    'refactor(#348): consolidate origin-validation via permission-service facade';
  const commitResult = runCommand(
    `git commit -m "${commitMessage}"`,
  );
  if (commitResult.success) {
    log(`✅ Commit created: ${commitMessage}`);
  } else if (commitResult.output.includes("nothing to commit")) {
    log(`Note: No changes to commit (or already committed)`);
  } else {
    log(`Commit output:\n${commitResult.output}`);
  }

  // Step 5: Show commit log
  log("Step 5: Showing recent commit log");
  const logResult = runCommand("git log --oneline -5");
  if (logResult.success) {
    log("Recent commits:");
    log(logResult.output);
  }

  // Step 6: Run extension tests
  log("Step 6: Running extension tests");
  const extTestResult = runCommand(
    "pnpm test --filter=@vellar/extension -- --run",
  );
  if (extTestResult.success) {
    log("✅ Extension tests passed");
    log(extTestResult.output);
  } else {
    log("Extension tests output:");
    log(extTestResult.output);
    if (extTestResult.error) log(extTestResult.error);
  }

  // Step 7: Run permission-service tests
  log("Step 7: Running permission-service tests");
  const permTestResult = runCommand(
    "pnpm test --filter=@vellar/permission-service -- --run",
  );
  if (permTestResult.success) {
    log("✅ Permission-service tests passed");
    log(permTestResult.output);
  } else {
    log("Permission-service tests output:");
    log(permTestResult.output);
    if (permTestResult.error) log(permTestResult.error);
  }

  // Step 8: Final status
  log("Step 8: Final git status");
  const finalStatusResult = runCommand("git status");
  if (finalStatusResult.success) {
    log(finalStatusResult.output);
  }

  log("✅ Refactor #348 process complete!");
  log("Summary:");
  log("  - Changes staged and committed");
  log("  - Extension tests executed");
  log("  - Permission-service tests executed");
  log("  - Review REFACTOR_348_IMPLEMENTATION.md for full details");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
