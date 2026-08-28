import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

function getSchedule() {
  return handleRequest({ method: "GET", path: "/vesting/schedule" });
}

function getClaimable(now) {
  return handleRequest({ method: "GET", path: "/vesting/claimable", query: { now } });
}

function postClaim(now) {
  return handleRequest({ method: "POST", path: "/vesting/claim", query: { now } });
}

resetState();

// The schedule endpoint returns the static release plan.
const scheduleResponse = getSchedule();
assert.equal(scheduleResponse.status, 200);
assert.equal(scheduleResponse.body.totalAmount, 10000);
assert.equal(scheduleResponse.body.releases.length, 4);

// Before the first release point: nothing is vested or claimable.
const beforeFirst = getClaimable("2025-12-01T00:00:00.000Z");
assert.equal(beforeFirst.status, 200);
assert.equal(beforeFirst.body.vested, 0);
assert.equal(beforeFirst.body.claimable, 0);

// Between the second and third release points: two tranches vested.
const betweenTranches = getClaimable("2026-05-01T00:00:00.000Z");
assert.equal(betweenTranches.status, 200);
assert.equal(betweenTranches.body.vested, 5000);
assert.equal(betweenTranches.body.claimable, 5000);

// Claiming at this point records the claim and zeroes out claimable.
const claimResult = postClaim("2026-05-01T00:00:00.000Z");
assert.equal(claimResult.status, 200);
assert.equal(claimResult.body.claimedThisRequest, 5000);
assert.equal(claimResult.body.totalClaimed, 5000);

const afterClaim = getClaimable("2026-05-01T00:00:00.000Z");
assert.equal(afterClaim.body.claimed, 5000);
assert.equal(afterClaim.body.claimable, 0);

// After all release points: fully vested, remaining claimable reflects
// only the amount not yet claimed.
const afterAll = getClaimable("2027-01-01T00:00:00.000Z");
assert.equal(afterAll.status, 200);
assert.equal(afterAll.body.vested, 10000);
assert.equal(afterAll.body.claimable, 5000);

// Missing/invalid simulated time is rejected.
assert.equal(handleRequest({ method: "GET", path: "/vesting/claimable", query: {} }).status, 400);
assert.equal(getClaimable("not-a-date").status, 400);

// Routing and method guards.
assert.equal(handleRequest({ method: "POST", path: "/vesting/schedule" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/unknown" }).status, 404);

console.log("PASS: vesting-release-suite tracks schedule and claimable amounts across simulated time");
