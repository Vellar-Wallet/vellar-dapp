import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const base = handleRequest({ query: { now: "2026-07-27T10:00:00.000Z" } });
assert.equal(base.status, 200);
assert.equal(typeof base.body.issuedAt, "string");
assert.equal(typeof base.body.expiresAt, "string");

// Before expiresAt, the session is not expired.
const before = handleRequest({ query: { now: "2026-07-27T12:00:00.000Z" } });
assert.equal(before.body.expired, false);

// At expiresAt, the session is considered expired.
const atExpiry = handleRequest({ query: { now: base.body.expiresAt } });
assert.equal(atExpiry.body.expired, true);

// Well after expiresAt, the session is still expired.
const after = handleRequest({ query: { now: "2026-07-28T00:00:00.000Z" } });
assert.equal(after.body.expired, true);

console.log("PASS: /session-expiry derives the expired flag from the current time");
