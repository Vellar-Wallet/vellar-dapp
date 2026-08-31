import assert from "node:assert/strict";
import {
  DEFAULT_GRACE_MS,
  createState,
  handleRequest,
} from "./route.mjs";

const startedAt = 1_000_000;
const expiresAt = startedAt + 60_000;
const state = createState({ now: startedAt, graceMs: DEFAULT_GRACE_MS });

let result = handleRequest("POST", "/session/expire", { now: expiresAt }, {}, state);
assert.equal(result.status, 200);
assert.equal(result.body.status, "expired");
assert.equal(result.body.expiresAt, expiresAt);

result = handleRequest("GET", "/session/check-session", {}, { now: expiresAt }, state);
assert.equal(result.status, 200);
assert.equal(result.body.status, "expired");

result = handleRequest(
  "POST",
  "/session/silent-refresh",
  { now: expiresAt + DEFAULT_GRACE_MS },
  {},
  state,
);
assert.equal(result.status, 200);
assert.equal(result.body.refreshed, true);
assert.equal(result.body.status, "active");

const refreshedExpiresAt = result.body.expiresAt;
result = handleRequest(
  "POST",
  "/session/silent-refresh",
  { now: refreshedExpiresAt + DEFAULT_GRACE_MS + 1 },
  {},
  state,
);
assert.equal(result.status, 401);
assert.equal(result.body.error, "reauthentication_required");

result = handleRequest(
  "GET",
  "/session/check-session",
  {},
  { now: refreshedExpiresAt + DEFAULT_GRACE_MS + 1 },
  state,
);
assert.equal(result.body.status, "expired");

console.log("PASS: session-silent-refresh suite — expire, refresh within grace, require reauthentication outside grace");