import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

function calculate(referenceDate) {
  return handleRequest({ method: "GET", path: "/vesting/calculation", query: { referenceDate } });
}

// Before the schedule starts: nothing released, everything locked.
const before = calculate("2025-06-01");
assert.equal(before.status, 200);
assert.equal(before.body.released, 0);
assert.equal(before.body.remaining, 12000);

// Midway through the schedule (exactly at the halfway point in time):
// roughly half should be released.
const during = calculate("2026-07-02T12:00:00.000Z");
assert.equal(during.status, 200);
assert.ok(during.body.released > 5900 && during.body.released < 6100);
assert.equal(
  Math.round((during.body.released + during.body.remaining) * 100) / 100,
  12000,
);

// After the schedule ends: fully released, nothing remaining.
const after = calculate("2027-06-01");
assert.equal(after.status, 200);
assert.equal(after.body.released, 12000);
assert.equal(after.body.remaining, 0);

// Missing referenceDate is rejected.
const missing = handleRequest({ method: "GET", path: "/vesting/calculation", query: {} });
assert.equal(missing.status, 400);
assert.equal(missing.body.error, "missing_reference_date");

// Invalid referenceDate is rejected.
const invalid = calculate("not-a-date");
assert.equal(invalid.status, 400);
assert.equal(invalid.body.error, "invalid_reference_date");

// Routing and method guards.
assert.equal(handleRequest({ method: "POST", path: "/vesting/calculation" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/unknown" }).status, 404);

console.log("PASS: vesting-calculation returns released/remaining before, during, and after the schedule");
