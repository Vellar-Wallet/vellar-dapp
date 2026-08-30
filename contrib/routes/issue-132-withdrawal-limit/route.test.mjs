import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// A known account returns its sample limit, used, and derived remaining.
const hit = handleRequest({ method: "GET", path: "/withdrawal-limit/acct_001" });
assert.equal(hit.status, 200);
assert.deepEqual(hit.body, {
  accountId: "acct_001",
  limit: 5000,
  used: 1250,
  remaining: 3750,
});
assert.equal(hit.body.remaining, hit.body.limit - hit.body.used);

// A fully-used account has zero remaining.
const exhausted = handleRequest({ method: "GET", path: "/withdrawal-limit/acct_002" });
assert.equal(exhausted.body.remaining, 0);

// An unknown account falls back to the default limit with correct remaining.
const unknown = handleRequest({ method: "GET", path: "/withdrawal-limit/acct_999" });
assert.equal(unknown.status, 200);
assert.equal(unknown.body.remaining, unknown.body.limit - unknown.body.used);

// A wrong method on a known path is rejected.
const wrongMethod = handleRequest({ method: "POST", path: "/withdrawal-limit/acct_001" });
assert.equal(wrongMethod.status, 405);

// An unrelated path is not found.
const unknownPath = handleRequest({ method: "GET", path: "/withdrawal-limit/" });
assert.equal(unknownPath.status, 404);

console.log("PASS: withdrawal-limit returns sample limit/used and a correct derived remaining");
