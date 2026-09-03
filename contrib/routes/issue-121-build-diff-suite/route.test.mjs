import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

function get(path, query = {}) {
  return handleRequest({ method: "GET", path, query });
}

// The builds endpoint lists sample records with the required fields.
const listed = get("/build-diff/builds");
assert.equal(listed.status, 200);
assert.equal(listed.body.count, listed.body.builds.length);
assert.ok(listed.body.count >= 2);
for (const build of listed.body.builds) {
  assert.equal(typeof build.id, "string");
  assert.equal(typeof build.wasmHash, "string");
  assert.equal(typeof build.size, "number");
}

// Two identical builds report no differing fields.
const identical = get("/build-diff/compare", { a: "build_001", b: "build_003" });
assert.equal(identical.status, 200);
assert.equal(identical.body.identical, true);
assert.deepEqual(identical.body.differingFields, []);
assert.deepEqual(identical.body.differences, []);

// Comparing a build with itself is also identical.
const self = get("/build-diff/compare", { a: "build_002", b: "build_002" });
assert.equal(self.body.identical, true);
assert.deepEqual(self.body.differingFields, []);

// Two differing builds report exactly the fields that differ.
const differing = get("/build-diff/compare", { a: "build_001", b: "build_002" });
assert.equal(differing.status, 200);
assert.equal(differing.body.identical, false);
assert.deepEqual(differing.body.differingFields, [
  "wasmHash",
  "size",
  "optimized",
]);
for (const difference of differing.body.differences) {
  assert.notEqual(difference.a, difference.b);
}

// A build differing only in compiler and hash reports just those fields.
const compilerOnly = get("/build-diff/compare", {
  a: "build_001",
  b: "build_004",
});
assert.deepEqual(compilerOnly.body.differingFields, ["wasmHash", "compiler"]);

// Comparison is symmetric in the reported field names.
const reversed = get("/build-diff/compare", { a: "build_002", b: "build_001" });
assert.deepEqual(
  reversed.body.differingFields,
  differing.body.differingFields,
);

// Missing and unknown build ids are rejected.
assert.equal(get("/build-diff/compare", { a: "build_001" }).status, 400);
assert.equal(get("/build-diff/compare", {}).status, 400);
const notFound = get("/build-diff/compare", { a: "build_001", b: "build_999" });
assert.equal(notFound.status, 404);
assert.equal(notFound.body.error, "build_not_found");

// Routing guards.
assert.equal(get("/build-diff/unknown").status, 404);
assert.equal(
  handleRequest({ method: "POST", path: "/build-diff/builds" }).status,
  405,
);

console.log("PASS: build-diff suite reports differing fields between builds");
