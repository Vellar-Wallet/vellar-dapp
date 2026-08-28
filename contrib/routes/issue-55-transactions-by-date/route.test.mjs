import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const ids = (result) => result.body.map((tx) => tx.id);

// No bounds: the whole sample set, oldest first.
const all = handleRequest({ query: {} });
assert.equal(all.status, 200);
assert.ok(Array.isArray(all.body));
assert.equal(all.body.length, 12);
assert.deepEqual(
  ids(all),
  [...all.body].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).map((tx) => tx.id),
);

// In range: both bounds set, and both are inclusive. tx_03 sits exactly on the
// lower bound and tx_05 exactly on the upper one.
const inRange = handleRequest({ query: { from: "2026-03-01", to: "2026-03-22" } });
assert.equal(inRange.status, 200);
assert.deepEqual(ids(inRange), ["tx_03", "tx_04", "tx_05"]);

// A date-only upper bound covers the whole day, not just its midnight tick:
// tx_04 happened at 23:59:59 on the 1st.
const singleDay = handleRequest({ query: { from: "2026-03-01", to: "2026-03-01" } });
assert.deepEqual(ids(singleDay), ["tx_03", "tx_04"]);

// Out of range: a window with no records is an empty array and a 200, never
// an error.
const empty = handleRequest({ query: { from: "2027-01-01", to: "2027-12-31" } });
assert.equal(empty.status, 200);
assert.deepEqual(empty.body, []);

// An inverted range is empty too, still without erroring.
const inverted = handleRequest({ query: { from: "2026-08-01", to: "2026-01-01" } });
assert.equal(inverted.status, 200);
assert.deepEqual(inverted.body, []);

// Each bound is optional on its own.
const fromOnly = handleRequest({ query: { from: "2026-07-01" } });
assert.deepEqual(ids(fromOnly), ["tx_10", "tx_11", "tx_12"]);

const toOnly = handleRequest({ query: { to: "2026-02-28" } });
assert.deepEqual(ids(toOnly), ["tx_01", "tx_02"]);

// Full ISO timestamps work as bounds as well, to the second.
const precise = handleRequest({
  query: { from: "2026-03-01T00:00:01Z", to: "2026-03-01T23:59:59Z" },
});
assert.deepEqual(ids(precise), ["tx_04"]);

// An unusable bound is dropped rather than rejected: the route still answers
// with a list, just an unfiltered one on that side.
const garbage = handleRequest({ query: { from: "yesterday", to: "2026-02-28" } });
assert.equal(garbage.status, 200);
assert.deepEqual(ids(garbage), ["tx_01", "tx_02"]);

console.log("PASS: /transactions-by-date filters on the from and to bounds");
