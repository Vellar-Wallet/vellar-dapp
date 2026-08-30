import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const ACCOUNT = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB";
const MIXED_ACCOUNT = "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF";

// Test inspect
{
  const { status, body } = handleRequest(`/inspect?account=${ACCOUNT}`);
  assert.equal(status, 200);
  assert.equal(body.account.account, ACCOUNT);
  assert.ok(Array.isArray(body.blockers));
}

// Test report returns sorted blockers
{
  const { status, body } = handleRequest(`/report?account=${ACCOUNT}`);
  assert.equal(status, 200);
  assert.ok(body.blockers.length >= 1);
  for (let i = 1; i < body.blockers.length; i++) {
    const prev = ["high", "medium", "low"].indexOf(
      body.blockers[i - 1].severity,
    );
    const curr = ["high", "medium", "low"].indexOf(body.blockers[i].severity);
    assert.ok(
      prev <= curr,
      `Expected severity order: ${body.blockers[i - 1].severity} before ${body.blockers[i].severity}`,
    );
  }
}

// Test missing account
{
  const { status, body } = handleRequest("/report");
  assert.equal(status, 400);
  assert.equal(body.error, "account_required");
}

// Test unknown account
{
  const { status, body } = handleRequest("/report?account=UNKNOWN");
  assert.equal(status, 404);
  assert.equal(body.error, "account_not_found");
}

// Test report with mixed severities (high, medium, low)
{
  const { status, body } = handleRequest(`/report?account=${MIXED_ACCOUNT}`);
  assert.equal(status, 200);
  assert.ok(body.blockers.length >= 3);
  const severityOrder = ["high", "medium", "low"];
  for (let i = 1; i < body.blockers.length; i++) {
    const prev = severityOrder.indexOf(body.blockers[i - 1].severity);
    const curr = severityOrder.indexOf(body.blockers[i].severity);
    assert.ok(
      prev <= curr,
      `Expected ${body.blockers[i - 1].severity} before ${body.blockers[i].severity}`,
    );
  }
  const severities = body.blockers.map((b) => b.severity);
  assert.ok(severities.includes("high"));
  assert.ok(severities.includes("medium"));
  assert.ok(severities.includes("low"));
}

console.log("PASS: blocker-report-suite tests");
