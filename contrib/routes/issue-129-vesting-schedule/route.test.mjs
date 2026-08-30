import assert from "node:assert/strict";
import { handleRequest, VESTING_SCHEDULE } from "./route.mjs";

const { status, body } = handleRequest({ method: "GET", path: "/vesting-schedule" });
assert.equal(status, 200);
assert.ok(Array.isArray(body.releases));
assert.ok(body.releases.length >= 3);

for (const entry of body.releases) {
  assert.equal(typeof entry.date, "string");
  assert.equal(typeof entry.amount, "string");
}

const dates = VESTING_SCHEDULE.releases.map((r) => new Date(r.date).getTime());
const sorted = [...dates].sort((a, b) => a - b);
assert.deepEqual(dates, sorted, "releases must be in chronological order");

const { status: badMethod } = handleRequest({ method: "POST", path: "/vesting-schedule" });
assert.equal(badMethod, 405);

const { status: notFound } = handleRequest({ method: "GET", path: "/nope" });
assert.equal(notFound, 404);

console.log("PASS: /vesting-schedule returns chronologically sorted release entries");
