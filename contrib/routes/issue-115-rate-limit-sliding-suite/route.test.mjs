import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const clientId = "test-client";
const baseTime = 1000000;

// Fill the window with 5 hits
for (let i = 0; i < 5; i++) {
  const res = handleRequest("POST", "/hit", { clientId, time: baseTime + i * 1000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.allowed, true);
  assert.equal(res.body.remaining, 4 - i);
}

// 6th hit should be rejected
let res = handleRequest("POST", "/hit", { clientId, time: baseTime + 5000 });
assert.equal(res.status, 429);
assert.equal(res.body.allowed, false);
assert.equal(res.body.remaining, 0);

// Check status
res = handleRequest("GET", "/status", null, { clientId, time: baseTime + 5000 });
assert.equal(res.status, 200);
assert.equal(res.body.used, 5);
assert.equal(res.body.remaining, 0);

// Age out: advance time past the 60s window from the last hit (baseTime+4000)
res = handleRequest("GET", "/status", null, { clientId, time: baseTime + 65000 });
assert.equal(res.body.used, 0);
assert.equal(res.body.remaining, 5);

// Hits should work again after window expires
res = handleRequest("POST", "/hit", { clientId, time: baseTime + 65000 });
assert.equal(res.status, 200);
assert.equal(res.body.allowed, true);

console.log("PASS: rate-limit-sliding suite — fill window, reject over-limit, age out, resume");
