import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Defaults: page 1, pageSize 10, out of 12 sample assets.
const defaults = handleRequest();
assert.equal(defaults.status, 200);
assert.equal(defaults.body.total, 12);
assert.equal(defaults.body.page, 1);
assert.equal(defaults.body.pageSize, 10);
assert.equal(defaults.body.items.length, 10);
assert.equal(defaults.body.items[0].code, "XLM");

// Second page returns the remainder.
const page2 = handleRequest({ query: { page: "2" } });
assert.equal(page2.body.page, 2);
assert.equal(page2.body.items.length, 2);
assert.equal(page2.body.total, 12);

// Custom pageSize changes how many pages are needed and slices accordingly.
const all = handleRequest({ query: { page: "1", pageSize: "12" } }).body.items;
const custom = handleRequest({ query: { page: "3", pageSize: "5" } });
assert.equal(custom.body.pageSize, 5);
assert.equal(custom.body.items.length, 2); // items 11-12 of 12
assert.deepEqual(custom.body.items, all.slice(10, 12));

// A page past the end returns an empty items array but preserves total.
const overflow = handleRequest({ query: { page: "99" } });
assert.equal(overflow.body.items.length, 0);
assert.equal(overflow.body.total, 12);

// Invalid page/pageSize values fall back to defaults instead of throwing.
const invalid = handleRequest({ query: { page: "0", pageSize: "-5" } });
assert.equal(invalid.body.page, 1);
assert.equal(invalid.body.pageSize, 10);

console.log("PASS: /assets paginates the sample asset list correctly");
