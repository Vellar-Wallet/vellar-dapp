import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// All three documented fields are present, with the documented types.
const { status, body } = handleRequest();
assert.equal(status, 200);
for (const field of ["limit", "remaining", "resetAt"]) {
  assert.ok(Object.hasOwn(body, field), `missing field: ${field}`);
}
assert.equal(typeof body.limit, "number");
assert.equal(typeof body.remaining, "number");
assert.equal(typeof body.resetAt, "string");

// remaining never exceeds limit and never goes negative.
assert.ok(body.remaining >= 0 && body.remaining <= body.limit);

// resetAt is a parseable ISO 8601 timestamp in the future.
const resetAt = new Date(body.resetAt);
assert.ok(!Number.isNaN(resetAt.getTime()), "resetAt is not a valid date");
assert.equal(resetAt.toISOString(), body.resetAt);
assert.ok(resetAt.getTime() > Date.now());

// The window is aligned to the epoch, so an injected clock gives a fixed
// answer: 09:15:37Z sits in the 09:15:00-09:16:00 window and resets at 09:16.
const fixed = handleRequest({ now: Date.parse("2026-07-20T09:15:37.500Z") });
assert.equal(fixed.body.resetAt, "2026-07-20T09:16:00.000Z");

// A caller landing exactly on a boundary gets the *next* boundary, never one
// that has already passed.
const onBoundary = handleRequest({ now: Date.parse("2026-07-20T09:15:00.000Z") });
assert.equal(onBoundary.body.resetAt, "2026-07-20T09:16:00.000Z");

console.log("PASS: /rate-limit-info returns limit, remaining and resetAt");
