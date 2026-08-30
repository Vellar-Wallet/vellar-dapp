import assert from "node:assert/strict";
import {
  createLookupService,
  handleRequest,
  handleMetricsRequest,
  NEGATIVE_CACHE_TTL_MS,
} from "./route.mjs";

// A fake clock so the TTL can be advanced deterministically instead of using
// real timers.
let currentTime = 1_000_000;
const now = () => currentTime;

// --- First lookup for an unknown hash goes to the database ---
{
  const service = createLookupService({ now });
  const first = handleRequest({ body: { hash: "unknown_hash_a" } }, service);
  assert.equal(first.status, 200);
  assert.equal(first.body.found, false);
  assert.equal(first.body.source, "database");
  assert.equal(service.getMetrics().databaseQueries, 1);
  assert.equal(service.getMetrics().negativeCacheMisses, 1);
  assert.equal(service.getMetrics().negativeCacheHits, 0);
}

// --- Repeated lookups within the TTL hit the negative cache, not the db ---
{
  const service = createLookupService({ now });
  handleRequest({ body: { hash: "unknown_hash_b" } }, service);

  const second = handleRequest({ body: { hash: "unknown_hash_b" } }, service);
  const third = handleRequest({ body: { hash: "unknown_hash_b" } }, service);

  assert.equal(second.body.source, "cache");
  assert.equal(third.body.source, "cache");
  assert.equal(
    service.getMetrics().databaseQueries,
    1,
    "cached lookups must not re-query the database",
  );
  assert.equal(service.getMetrics().negativeCacheHits, 2);
}

// --- After the TTL elapses, the entry expires and the db is hit again ---
{
  const service = createLookupService({ now });
  handleRequest({ body: { hash: "unknown_hash_c" } }, service);
  currentTime += NEGATIVE_CACHE_TTL_MS + 1;

  const afterExpiry = handleRequest({ body: { hash: "unknown_hash_c" } }, service);
  assert.equal(afterExpiry.body.source, "database");
  assert.equal(service.getMetrics().databaseQueries, 2);
  assert.equal(service.getMetrics().negativeCacheMisses, 2);
}

// --- Known hashes always report found and are not subject to negative caching ---
{
  const service = createLookupService({ now });
  const first = handleRequest({ body: { hash: "wasm_verified_escrow_v1" } }, service);
  const second = handleRequest({ body: { hash: "wasm_verified_escrow_v1" } }, service);
  assert.equal(first.body.found, true);
  assert.equal(second.body.found, true);
  assert.equal(second.body.source, "database");
  assert.equal(service.getMetrics().negativeCacheHits, 0);
}

// --- Metrics report a negative cache hit rate ---
{
  const service = createLookupService({ now });
  handleRequest({ body: { hash: "unknown_hash_d" } }, service);
  handleRequest({ body: { hash: "unknown_hash_d" } }, service);
  handleRequest({ body: { hash: "unknown_hash_d" } }, service);

  const metrics = handleMetricsRequest(service).body;
  assert.equal(metrics.negativeCacheMisses, 1);
  assert.equal(metrics.negativeCacheHits, 2);
  assert.equal(metrics.negativeCacheHitRate, 2 / 3);
}

// --- Malformed input is rejected ---
{
  assert.equal(handleRequest({ body: {} }).status, 400);
  assert.equal(handleRequest({ body: { hash: "" } }).status, 400);
  assert.equal(handleRequest({ body: { hash: 123 } }).status, 400);
}

console.log("PASS: negative caching for unknown contract hash lookups");
