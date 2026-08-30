import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// A known account id returns its sample address and memo.
const hit = handleRequest({ method: "GET", path: "/deposit-address/acct_001" });
assert.equal(hit.status, 200);
assert.deepEqual(hit.body, {
  accountId: "acct_001",
  address: "GA111DEPOSITXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  memo: "100231",
});

// A second known account id returns its own address and memo.
const hit2 = handleRequest({ method: "GET", path: "/deposit-address/acct_002" });
assert.equal(hit2.status, 200);
assert.equal(hit2.body.memo, "100232");

// An unknown account id returns a 404-style payload.
const miss = handleRequest({ method: "GET", path: "/deposit-address/acct_999" });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");

// A wrong method on a known path is rejected separately from not-found.
const wrongMethod = handleRequest({ method: "POST", path: "/deposit-address/acct_001" });
assert.equal(wrongMethod.status, 405);

// An unrelated path is not found.
const unknownPath = handleRequest({ method: "GET", path: "/deposit-address/" });
assert.equal(unknownPath.status, 404);

console.log("PASS: deposit-address returns sample address/memo and 404s on unknown accounts");
