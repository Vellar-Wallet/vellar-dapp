import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// --- Primary path succeeds by default ---
{
  const result = handleRequest({ body: { transaction: { op: "payment", amount: 10 } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.handledBy, "primary");
  assert.ok(result.body.submissionId.startsWith("primary_"));
  assert.deepEqual(result.body.attempts, [{ path: "primary", ok: true }]);
}

// --- Forcing primary failure falls back to the secondary path ---
{
  const result = handleRequest({
    body: { transaction: { op: "payment", amount: 10 }, forcePrimaryFailure: true },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.handledBy, "fallback");
  assert.ok(result.body.submissionId.startsWith("fallback_"));
  assert.equal(result.body.attempts.length, 2);
  assert.equal(result.body.attempts[0].path, "primary");
  assert.equal(result.body.attempts[0].ok, false);
  assert.equal(result.body.attempts[1].path, "fallback");
  assert.equal(result.body.attempts[1].ok, true);
}

// --- A string transaction (e.g. a signed XDR blob) is accepted too ---
{
  const result = handleRequest({ body: { transaction: "AAAAAgAAAAA..." } });
  assert.equal(result.status, 200);
  assert.equal(result.body.handledBy, "primary");
}

// --- Malformed input is rejected ---
{
  assert.equal(handleRequest({ body: {} }).status, 400);
  assert.equal(handleRequest({ body: { transaction: "" } }).status, 400);
  assert.equal(handleRequest({ body: { transaction: null } }).status, 400);
  assert.equal(
    handleRequest({ body: { transaction: "x", forcePrimaryFailure: "yes" } }).status,
    400,
  );
}

console.log("PASS: relayer fallback route handles primary success and fallback cases");
