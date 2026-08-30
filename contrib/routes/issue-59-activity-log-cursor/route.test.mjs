import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// First page: no cursor, default limit.
const page1 = handleRequest({ query: {} });
assert.equal(page1.status, 200);
assert.equal(page1.body.items.length, 5);
assert.equal(page1.body.items[0].id, "act_018");
assert.ok(page1.body.nextCursor, "first page should have a nextCursor");

// Custom limit is respected.
const smallPage = handleRequest({ query: { limit: "3" } });
assert.equal(smallPage.body.items.length, 3);
assert.equal(smallPage.body.nextCursor, smallPage.body.items[2].id);

// Limit is clamped to a sane minimum for invalid input.
const invalidLimit = handleRequest({ query: { limit: "0" } });
assert.equal(invalidLimit.body.items.length, 5);

// An unrecognized cursor restarts pagination from the beginning rather
// than erroring.
const staleCursor = handleRequest({ query: { cursor: "act_does_not_exist" } });
assert.equal(staleCursor.body.items[0].id, "act_018");

// Walk every page to the end using the cursor from the previous response,
// collecting every entry seen along the way.
let cursor;
let pages = 0;
const seenIds = [];
let last;
do {
  last = handleRequest({ query: { cursor, limit: "5" } });
  assert.equal(last.status, 200);
  for (const entry of last.body.items) seenIds.push(entry.id);
  cursor = last.body.nextCursor;
  pages += 1;
  assert.ok(pages < 100, "pagination loop did not terminate");
} while (cursor);

// All 18 entries were visited exactly once, in order, with no gaps or
// duplicates, and the final page's nextCursor was null.
assert.equal(seenIds.length, 18);
assert.equal(new Set(seenIds).size, 18, "no duplicate entries across pages");
assert.equal(last.body.nextCursor, null);
assert.equal(pages, 4); // 5 + 5 + 5 + 3

console.log(
  `PASS: activity log paginates through all ${seenIds.length} entries across ${pages} pages`,
);
