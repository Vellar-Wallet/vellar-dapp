import assert from "node:assert/strict";
import { handleCheck, handleRefresh } from "./route.mjs";

// The sample session starts out expired relative to a "now" well past its
// hardcoded expiresAt.
const initialCheck = handleCheck({ now: "2026-07-28T00:00:00.000Z" });
assert.equal(initialCheck.status, 200);
assert.equal(initialCheck.body.expired, true);
const oldToken = initialCheck.body.token;

// Refreshing issues a new token and a new (later) expiresAt.
const refreshed = handleRefresh({ now: "2026-07-28T00:00:00.000Z" });
assert.equal(refreshed.status, 200);
assert.notEqual(refreshed.body.token, oldToken);
assert.ok(new Date(refreshed.body.expiresAt).getTime() > new Date("2026-07-28T00:00:00.000Z").getTime());

// Checking again right after refresh (same "now") reports not expired, and
// reflects the new token.
const afterRefresh = handleCheck({ now: "2026-07-28T00:00:00.000Z" });
assert.equal(afterRefresh.status, 200);
assert.equal(afterRefresh.body.expired, false);
assert.equal(afterRefresh.body.token, refreshed.body.token);

console.log("PASS: /session-refresh check -> refresh -> check reflects the new session");
