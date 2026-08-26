import assert from "node:assert/strict";
import { AuditLogAggregator, handleRequest } from "./route.mjs";

const aggregator = new AuditLogAggregator();

// Test 1: Get all entries without filters (default pagination)
const allEntries = aggregator.getEntries();
assert.equal(allEntries.entries.length, 10, "Should return 10 entries by default");
assert.equal(allEntries.pagination.limit, 10, "Default limit should be 10");
assert.equal(allEntries.pagination.offset, 0, "Default offset should be 0");
assert.equal(allEntries.pagination.total, 30, "Total should be 30");
assert.equal(allEntries.pagination.hasMore, true, "Should have more entries");

// Test 2: Get entries with custom limit
const limitedEntries = aggregator.getEntries({ limit: 5 });
assert.equal(limitedEntries.entries.length, 5, "Should return 5 entries");
assert.equal(limitedEntries.pagination.limit, 5, "Limit should be 5");
assert.equal(limitedEntries.pagination.hasMore, true, "Should have more entries");

// Test 3: Get entries with offset (pagination)
const offsetEntries = aggregator.getEntries({ limit: 10, offset: 10 });
assert.equal(offsetEntries.entries.length, 10, "Should return 10 entries");
assert.equal(offsetEntries.pagination.offset, 10, "Offset should be 10");
assert.ok(offsetEntries.entries[0].id !== "audit-001", "Should skip first 10 entries");

// Test 4: Get last page of entries
const lastPage = aggregator.getEntries({ limit: 10, offset: 20 });
assert.equal(lastPage.entries.length, 10, "Should return remaining 10 entries");
assert.equal(lastPage.pagination.hasMore, false, "Should not have more entries");

// Test 5: Filter by actor only
const aliceEntries = aggregator.getEntries({ actor: "user-alice" });
assert.ok(aliceEntries.entries.length > 0, "Should find entries for user-alice");
assert.ok(
  aliceEntries.entries.every((e) => e.actor === "user-alice"),
  "All entries should be from user-alice"
);

// Test 6: Filter by action only
const createEntries = aggregator.getEntries({ action: "create" });
assert.ok(createEntries.entries.length > 0, "Should find create action entries");
assert.ok(
  createEntries.entries.every((e) => e.action === "create"),
  "All entries should have create action"
);

// Test 7: Combined filter (actor + action)
const aliceCreateEntries = aggregator.getEntries({
  actor: "user-alice",
  action: "create",
});
assert.ok(
  aliceCreateEntries.entries.length > 0,
  "Should find entries for user-alice with create action"
);
assert.ok(
  aliceCreateEntries.entries.every(
    (e) => e.actor === "user-alice" && e.action === "create"
  ),
  "All entries should match both filters"
);

// Test 8: Combined filter with pagination
const bobUpdatePaginated = aggregator.getEntries({
  actor: "user-bob",
  action: "update",
  limit: 2,
  offset: 0,
});
assert.ok(
  bobUpdatePaginated.entries.every(
    (e) => e.actor === "user-bob" && e.action === "update"
  ),
  "Paginated results should match combined filter"
);

// Test 9: Filter returns empty when no matches
const noMatchEntries = aggregator.getEntries({
  actor: "nonexistent-user",
});
assert.equal(
  noMatchEntries.entries.length,
  0,
  "Should return empty array for no matches"
);
assert.equal(noMatchEntries.pagination.total, 0, "Total should be 0");
assert.equal(noMatchEntries.pagination.hasMore, false, "Should not have more");

// Test 10: Get summary counts
const summary = aggregator.getSummary();
assert.ok(summary.summary, "Should return summary object");
assert.ok(summary.totalEntries, "Should return total entries count");
assert.equal(summary.totalEntries, 30, "Total entries should be 30");

// Test 11: Verify summary counts by action
assert.ok(summary.summary.create > 0, "Should have create actions");
assert.ok(summary.summary.update > 0, "Should have update actions");
assert.ok(summary.summary.delete > 0, "Should have delete actions");
assert.ok(summary.summary.approve > 0, "Should have approve actions");
assert.ok(summary.summary.reject > 0, "Should have reject actions");
assert.ok(summary.summary.transfer > 0, "Should have transfer actions");

// Test 12: Verify summary totals add up
const summaryTotal = Object.values(summary.summary).reduce(
  (sum, count) => sum + count,
  0
);
assert.equal(
  summaryTotal,
  summary.totalEntries,
  "Summary counts should add up to total entries"
);

// Test 13: Count specific action in dataset
const createCount = aggregator
  .getEntries({ action: "create", limit: 100 })
  .entries.length;
assert.equal(
  summary.summary.create,
  createCount,
  "Summary create count should match filtered entries"
);

// Test 14: Test request handler with entries action
const entriesRequest = handleRequest("entries", { limit: 5 });
assert.equal(entriesRequest.status, 200);
assert.equal(entriesRequest.body.entries.length, 5);

// Test 15: Test request handler with summary action
const summaryRequest = handleRequest("summary", {});
assert.equal(summaryRequest.status, 200);
assert.ok(summaryRequest.body.summary);
assert.equal(summaryRequest.body.totalEntries, 30);

// Test 16: Test request handler with actor filter
const actorRequest = handleRequest("entries", { actor: "user-alice" });
assert.equal(actorRequest.status, 200);
assert.ok(
  actorRequest.body.entries.every((e) => e.actor === "user-alice"),
  "Handler should filter by actor"
);

// Test 17: Test request handler with action filter
const actionRequest = handleRequest("entries", { action: "delete" });
assert.equal(actionRequest.status, 200);
assert.ok(
  actionRequest.body.entries.every((e) => e.action === "delete"),
  "Handler should filter by action"
);

// Test 18: Test request handler with combined filter and pagination
const combinedRequest = handleRequest("entries", {
  actor: "user-bob",
  action: "create",
  limit: "3",
  offset: "0",
});
assert.equal(combinedRequest.status, 200);
assert.ok(
  combinedRequest.body.entries.every(
    (e) => e.actor === "user-bob" && e.action === "create"
  ),
  "Handler should apply combined filters"
);

// Test 19: Test request handler with unknown action
const unknownRequest = handleRequest("unknown", {});
assert.equal(unknownRequest.status, 400);
assert.equal(unknownRequest.body.error, "unknown_action");

// Test 20: Verify system-cleanup actor entries
const cleanupEntries = aggregator.getEntries({ actor: "system-cleanup" });
assert.ok(
  cleanupEntries.entries.length > 0,
  "Should find system-cleanup entries"
);
assert.ok(
  cleanupEntries.entries.every((e) => e.actor === "system-cleanup"),
  "All entries should be from system-cleanup"
);

// Test 21: Verify admin-charlie actor entries
const adminEntries = aggregator.getEntries({ actor: "admin-charlie" });
assert.ok(adminEntries.entries.length > 0, "Should find admin-charlie entries");
assert.ok(
  adminEntries.entries.every((e) => e.actor === "admin-charlie"),
  "All entries should be from admin-charlie"
);

// Test 22: Verify all entries have required fields
const allUnfiltered = aggregator.getEntries({ limit: 100 });
for (const entry of allUnfiltered.entries) {
  assert.ok(entry.id, "Entry should have id");
  assert.ok(entry.timestamp, "Entry should have timestamp");
  assert.ok(entry.actor, "Entry should have actor");
  assert.ok(entry.action, "Entry should have action");
  assert.ok(entry.resource, "Entry should have resource");
  assert.ok(entry.result, "Entry should have result");
}

console.log("PASS: All audit log aggregation tests passed cleanly!");
console.log(`  ✓ ${22} test groups passed`);
console.log(`  ✓ Pagination with limit and offset`);
console.log(`  ✓ Filter by actor`);
console.log(`  ✓ Filter by action`);
console.log(`  ✓ Combined filters (actor + action + pagination)`);
console.log(`  ✓ Summary aggregation by action`);
console.log(`  ✓ Request handler integration`);
console.log(`  ✓ Edge cases (no matches, empty filters)`);
