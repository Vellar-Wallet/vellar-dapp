import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const HEX_64 = /^[0-9a-f]{64}$/;
const KNOWN_ID = "CA0000000000000000000000000000000000000000000000000001";

// A known contract id returns its wasm hash as a 64 character hex string.
const hit = handleRequest({ params: { contractId: KNOWN_ID } });
assert.equal(hit.status, 200);
assert.equal(hit.body.contractId, KNOWN_ID);
assert.equal(hit.body.wasmHash.length, 64);
assert.match(hit.body.wasmHash, HEX_64);
assert.equal(typeof hit.body.network, "string");

// Every sample entry uses the same hash format.
for (const id of [
  "CA0000000000000000000000000000000000000000000000000002",
  "CA0000000000000000000000000000000000000000000000000003",
]) {
  const { status, body } = handleRequest({ params: { contractId: id } });
  assert.equal(status, 200);
  assert.match(body.wasmHash, HEX_64);
}

// An unknown contract id returns a 404-style payload.
const miss = handleRequest({ params: { contractId: "CAUNKNOWN" } });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");
assert.equal(miss.body.wasmHash, undefined);

// A missing contract id is also treated as not found.
const noId = handleRequest({});
assert.equal(noId.status, 404);

console.log("PASS: /contracts/:contractId/hash returns a wasm hash on a hit and 404 on a miss");
