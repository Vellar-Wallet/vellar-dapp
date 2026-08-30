import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

function get(path, query = {}) {
  return handleRequest({ method: "GET", path, query });
}

// All three load levels produce a successful estimate.
const low = get("/fee-load/estimate", { load: "low" });
const medium = get("/fee-load/estimate", { load: "medium" });
const high = get("/fee-load/estimate", { load: "high" });

for (const result of [low, medium, high]) {
  assert.equal(result.status, 200);
  assert.equal(result.body.operations, 1);
  assert.equal(result.body.unit, "stroops");
  assert.equal(typeof result.body.estimatedFee, "number");
}

// Each level produces a distinct estimate, increasing with load.
assert.ok(low.body.estimatedFee < medium.body.estimatedFee);
assert.ok(medium.body.estimatedFee < high.body.estimatedFee);
assert.equal(
  new Set([low, medium, high].map((r) => r.body.estimatedFee)).size,
  3,
);

// The estimate scales linearly with the operation count.
const highTen = get("/fee-load/estimate", { load: "high", operations: "10" });
assert.equal(highTen.body.estimatedFee, high.body.estimatedFee * 10);

// Unknown and missing load levels are rejected.
assert.equal(get("/fee-load/estimate", { load: "extreme" }).status, 400);
assert.equal(get("/fee-load/estimate", {}).status, 400);

// Operation counts must be plain positive integers within range.
for (const operations of ["0", "-1", "2.5", "3abc", "101"]) {
  const result = get("/fee-load/estimate", { load: "low", operations });
  assert.equal(result.status, 400, `expected 400 for operations=${operations}`);
  assert.equal(result.body.error, "invalid_operations");
}

// The history endpoint returns the fixed sample series.
const history = get("/fee-load/load-history");
assert.equal(history.status, 200);
assert.equal(history.body.count, history.body.samples.length);
assert.ok(history.body.count > 0);
assert.equal(history.body.latest, history.body.samples.at(-1).load);
for (const sample of history.body.samples) {
  assert.ok(["low", "medium", "high"].includes(sample.load));
  assert.equal(typeof sample.observedAt, "string");
}

// Every level seen in the history can be estimated.
for (const sample of history.body.samples) {
  assert.equal(get("/fee-load/estimate", { load: sample.load }).status, 200);
}

// Routing guards.
assert.equal(get("/fee-load/unknown").status, 404);
assert.equal(
  handleRequest({ method: "POST", path: "/fee-load/estimate" }).status,
  405,
);

console.log("PASS: fee-load suite scales fees across all three load levels");
