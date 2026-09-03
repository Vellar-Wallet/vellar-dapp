import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// No search: the full list comes back, and every entry has a code and a name.
const all = handleRequest();
assert.equal(all.status, 200);
assert.equal(all.body.total, all.body.items.length);
assert.ok(all.body.items.length >= 6, "expected at least 6 sample assets");
assert.equal(all.body.search, null);
for (const asset of all.body.items) {
  assert.equal(typeof asset.code, "string");
  assert.equal(typeof asset.name, "string");
  assert.ok(asset.code.length > 0 && asset.name.length > 0);
}

// Asset codes are unique.
const codes = all.body.items.map((asset) => asset.code);
assert.equal(new Set(codes).size, codes.length);

// Search filters by code prefix, not by substring or display name.
const us = handleRequest({ query: { search: "US" } });
assert.deepEqual(
  us.body.items.map((asset) => asset.code),
  ["USDC", "USDT"],
);
assert.equal(us.body.total, 2);
assert.equal(us.body.search, "US");

// The prefix match is case-insensitive in both directions.
assert.deepEqual(handleRequest({ query: { search: "usd" } }).body.items, us.body.items);
assert.deepEqual(
  handleRequest({ query: { search: "YXLM" } }).body.items.map((asset) => asset.code),
  ["yXLM"],
);

// A full code matches exactly one asset.
const exact = handleRequest({ query: { search: "XLM" } });
assert.deepEqual(
  exact.body.items.map((asset) => asset.code),
  ["XLM"],
);

// Substring matches that are not prefixes are excluded ("XLM" is inside "yXLM").
assert.equal(
  exact.body.items.some((asset) => asset.code === "yXLM"),
  false,
);

// Matching against a display name rather than a code returns nothing.
assert.equal(handleRequest({ query: { search: "Bitcoin" } }).body.total, 0);

// An unknown prefix returns an empty list, not an error.
const none = handleRequest({ query: { search: "zzz" } });
assert.equal(none.status, 200);
assert.deepEqual(none.body.items, []);
assert.equal(none.body.total, 0);

// Empty and whitespace-only searches fall back to the full list.
assert.equal(handleRequest({ query: { search: "" } }).body.total, all.body.total);
assert.equal(handleRequest({ query: { search: "   " } }).body.total, all.body.total);

console.log("PASS: /supported-assets lists assets and filters by code prefix");
