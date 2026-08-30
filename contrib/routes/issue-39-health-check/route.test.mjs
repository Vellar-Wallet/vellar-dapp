import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// The status field is "ok".
const health = handleRequest();
assert.equal(health.status, 200);
assert.equal(health.body.status, "ok");
assert.equal(health.body.service, "vellar-mock");

// Uptime is a non-negative whole number of seconds.
assert.equal(typeof health.body.uptimeSeconds, "number");
assert.ok(Number.isInteger(health.body.uptimeSeconds));
assert.ok(health.body.uptimeSeconds >= 0);

// The timestamps are valid ISO-8601 strings.
assert.equal(Number.isNaN(Date.parse(health.body.timestamp)), false);
assert.equal(Number.isNaN(Date.parse(health.body.startedAt)), false);
assert.equal(new Date(health.body.timestamp).toISOString(), health.body.timestamp);

// With injected values the payload is fully deterministic.
const fixed = handleRequest({ now: Date.parse("2026-07-28T12:00:00.000Z"), uptimeSeconds: 90 });
assert.equal(fixed.body.status, "ok");
assert.equal(fixed.body.uptimeSeconds, 90);
assert.equal(fixed.body.timestamp, "2026-07-28T12:00:00.000Z");
assert.equal(fixed.body.startedAt, "2026-07-28T11:58:30.000Z");

// startedAt is always uptimeSeconds before timestamp.
const elapsed = (Date.parse(fixed.body.timestamp) - Date.parse(fixed.body.startedAt)) / 1000;
assert.equal(elapsed, fixed.body.uptimeSeconds);

// Fractional uptime is floored, and a negative reading is clamped to zero.
assert.equal(handleRequest({ uptimeSeconds: 12.9 }).body.uptimeSeconds, 12);
assert.equal(handleRequest({ uptimeSeconds: -5 }).body.uptimeSeconds, 0);

console.log("PASS: /health reports status ok with an uptime and timestamp");
