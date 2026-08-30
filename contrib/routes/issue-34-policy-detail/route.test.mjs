import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// A known id returns the full record, including limit and window.
const hit = handleRequest({ params: { id: "pol_1001" } });
assert.equal(hit.status, 200);
assert.equal(hit.body.id, "pol_1001");
assert.equal(hit.body.type, "spending-limit");
assert.equal(hit.body.limit, "500.0000000");
assert.equal(hit.body.window, "daily");

// An unknown id returns a 404-style payload.
const miss = handleRequest({ params: { id: "pol_9999" } });
assert.equal(miss.status, 404);
assert.equal(miss.body.error, "not_found");

// A missing id is also treated as not found.
const noId = handleRequest({});
assert.equal(noId.status, 404);

console.log("PASS: /policies/:id returns the record on a hit and 404 on a miss");
