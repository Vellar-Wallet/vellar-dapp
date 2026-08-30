import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// First page: no cursor supplied, so the route starts at the beginning.
const first = handleRequest({ query: {} });
assert.equal(first.status, 200);
assert.ok(Array.isArray(first.body.items));
assert.equal(first.body.items.length, 4);
assert.deepEqual(
  first.body.items.map((item) => item.id),
  ["itm_01", "itm_02", "itm_03", "itm_04"],
);
assert.equal(typeof first.body.nextCursor, "string");

// An empty cursor means the same thing as no cursor at all.
assert.deepEqual(handleRequest({ query: { cursor: "" } }).body, first.body);

// Second page: following nextCursor advances without repeating items.
const second = handleRequest({ query: { cursor: first.body.nextCursor } });
assert.equal(second.status, 200);
assert.deepEqual(
  second.body.items.map((item) => item.id),
  ["itm_05", "itm_06", "itm_07", "itm_08"],
);
assert.equal(typeof second.body.nextCursor, "string");
assert.notEqual(second.body.nextCursor, first.body.nextCursor);

// Last page: a short page, and nextCursor is null rather than absent.
const last = handleRequest({ query: { cursor: second.body.nextCursor } });
assert.equal(last.status, 200);
assert.deepEqual(
  last.body.items.map((item) => item.id),
  ["itm_09", "itm_10"],
);
assert.ok(Object.hasOwn(last.body, "nextCursor"));
assert.equal(last.body.nextCursor, null);

// Walking the pages visits every item exactly once, in order.
const walked = [];
let cursor;
do {
  const page = handleRequest({ query: cursor ? { cursor } : {} });
  walked.push(...page.body.items);
  cursor = page.body.nextCursor;
} while (cursor !== null);
assert.equal(walked.length, 10);
assert.equal(new Set(walked.map((item) => item.id)).size, 10);

// A cursor we never issued is rejected instead of silently paging from 0.
for (const bad of ["not-a-cursor", Buffer.from("offset:3").toString("base64url")]) {
  const rejected = handleRequest({ query: { cursor: bad } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "invalid_cursor");
}

console.log("PASS: /cursor-page pages through items and ends with nextCursor null");
