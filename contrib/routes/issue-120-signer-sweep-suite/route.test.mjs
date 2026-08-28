import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

function list(now) {
  return handleRequest({
    method: "GET",
    path: "/signer-sweep/list-signers",
    query: { now },
  });
}

function sweep(now) {
  return handleRequest({
    method: "POST",
    path: "/signer-sweep/run-sweep",
    body: { now },
  });
}

// At this simulated time, two session keys have passed their expiry and
// three signers (admin, device, recovery) are still active.
const NOW = "2026-07-27T20:00:00.000Z";

resetState();

// Before any sweep, every signer is still active but the expired ones are
// flagged as pending.
const before = list(NOW);
assert.equal(before.status, 200);
assert.equal(before.body.now, NOW);
assert.equal(before.body.removedCount, 0);
assert.equal(before.body.activeCount, before.body.signers.length);
assert.deepEqual(
  before.body.signers.filter((s) => s.sweepPending).map((s) => s.id),
  ["signer_session_a", "signer_session_b"],
);

// The sweep removes exactly the expired signers.
const first = sweep(NOW);
assert.equal(first.status, 200);
assert.equal(first.body.removedCount, 2);
assert.deepEqual(first.body.removedSignerIds, [
  "signer_session_a",
  "signer_session_b",
]);
assert.equal(first.body.sweepRun, 1);

// Only the expired signers changed; the rest are untouched and active.
const after = list(NOW);
assert.equal(after.body.removedCount, 2);
assert.equal(after.body.sweepPendingCount, 0);
for (const signer of after.body.signers) {
  const expired =
    signer.expiresAt !== null &&
    new Date(signer.expiresAt).getTime() <= new Date(NOW).getTime();
  assert.equal(signer.status, expired ? "removed" : "active", signer.id);
  assert.equal(signer.removedAt, expired ? NOW : null, signer.id);
}

// A signer that never expires is never swept.
const admin = after.body.signers.find((s) => s.id === "signer_admin");
assert.equal(admin.expiresAt, null);
assert.equal(admin.status, "active");

// Re-running at the same time is a no-op: nothing is left to remove.
const second = sweep(NOW);
assert.equal(second.body.removedCount, 0);
assert.deepEqual(second.body.removedSignerIds, []);
assert.equal(second.body.sweepRun, 2);

// Advancing simulated time sweeps the next signer to expire.
const later = sweep("2026-07-28T12:00:00.000Z");
assert.equal(later.body.removedCount, 1);
assert.deepEqual(later.body.removedSignerIds, ["signer_device"]);
assert.equal(later.body.remainingActive, 2);

// Expiry is inclusive: a signer is swept exactly at its expiresAt.
resetState();
const atBoundary = sweep("2026-07-27T12:00:00.000Z");
assert.deepEqual(atBoundary.body.removedSignerIds, ["signer_session_a"]);

// A moment earlier, nothing is expired yet.
resetState();
assert.equal(sweep("2026-07-27T11:59:59.999Z").body.removedCount, 0);

// An unparseable simulated time is rejected by both endpoints.
assert.equal(list("not-a-date").status, 400);
assert.equal(sweep("not-a-date").status, 400);
assert.equal(sweep("not-a-date").body.error, "invalid_now");

// Routing and method guards.
assert.equal(
  handleRequest({ method: "GET", path: "/signer-sweep/run-sweep" }).status,
  405,
);
assert.equal(
  handleRequest({ method: "POST", path: "/signer-sweep/list-signers" }).status,
  405,
);
assert.equal(
  handleRequest({ method: "GET", path: "/signer-sweep/unknown" }).status,
  404,
);

console.log("PASS: signer-sweep suite removes only expired signers");
