import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

resetState();

// A sample nickname is removed and echoed back.
const hit = handleRequest({ method: "DELETE", path: "/nicknames/Mum" });
assert.equal(hit.status, 200);
assert.deepEqual(hit.body, { removed: true, nickname: "Mum" });

// The same nickname is no longer found on a second delete.
const secondDelete = handleRequest({ method: "DELETE", path: "/nicknames/Mum" });
assert.equal(secondDelete.status, 404);
assert.equal(secondDelete.body.error, "not_found");

// A nickname never in the sample dataset returns 404.
const neverExisted = handleRequest({ method: "DELETE", path: "/nicknames/Unknown" });
assert.equal(neverExisted.status, 404);

// A nickname with a space, URI-encoded in the path, is decoded and removed.
const encoded = handleRequest({ method: "DELETE", path: "/nicknames/Savings%20Pool" });
assert.equal(encoded.status, 200);
assert.equal(encoded.body.nickname, "Savings Pool");

// A wrong method on a known path is rejected.
const wrongMethod = handleRequest({ method: "GET", path: "/nicknames/Landlord" });
assert.equal(wrongMethod.status, 405);

// An unrelated path is not found.
const unknownPath = handleRequest({ method: "DELETE", path: "/nicknames/" });
assert.equal(unknownPath.status, 404);

console.log("PASS: remove-nickname deletes sample nicknames and 404s when absent");
