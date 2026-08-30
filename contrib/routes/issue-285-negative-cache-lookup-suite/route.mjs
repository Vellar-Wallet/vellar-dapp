// Mock route simulating a contract-hash lookup service with negative caching.
// A "not found" result is cached for a short TTL so repeated lookups for a
// hash that does not exist stop hitting the (simulated) database. Positive
// lookups are out of scope for this issue and always go to the database.
import http from "node:http";
import { pathToFileURL } from "node:url";

// TTL for a negative ("not found") cache entry, in milliseconds.
//
// 30s was picked to balance two costs: a hash that gets registered right
// after being looked up should not be treated as missing for long (staleness
// cost), but a wallet or indexer that polls for a not-yet-deployed contract
// every few seconds should not hammer the database on every attempt (load
// cost). 30s absorbs typical retry/poll intervals (a few requests) while
// keeping staleness inside a single user-visible interaction.
export const NEGATIVE_CACHE_TTL_MS = 30_000;

// Stand-in for the verified-contract-hash database. Anything not in this set
// is "unknown" for the purposes of this mock.
const KNOWN_HASHES = new Set([
  "wasm_verified_escrow_v1",
  "wasm_verified_vault_v1",
  "wasm_verified_recipient_list_v1",
]);

/**
 * Creates an isolated lookup service instance. Each instance has its own
 * cache and metrics, and accepts an injectable clock so tests can control
 * TTL expiry without real timers.
 */
export function createLookupService({
  now = () => Date.now(),
  ttlMs = NEGATIVE_CACHE_TTL_MS,
} = {}) {
  // Map<hash, expiresAt>. Presence of a live (non-expired) entry means "we
  // already know this hash is not found; don't ask the database again."
  const negativeCache = new Map();

  const metrics = {
    databaseQueries: 0,
    negativeCacheHits: 0,
    negativeCacheMisses: 0,
  };

  function isLive(hash) {
    const expiresAt = negativeCache.get(hash);
    return expiresAt !== undefined && expiresAt > now();
  }

  function lookup(hash) {
    if (KNOWN_HASHES.has(hash)) {
      metrics.databaseQueries += 1;
      return { hash, found: true, source: "database" };
    }

    if (isLive(hash)) {
      metrics.negativeCacheHits += 1;
      return {
        hash,
        found: false,
        source: "cache",
        cachedUntil: new Date(negativeCache.get(hash)).toISOString(),
      };
    }

    // Cache miss (never looked up, or a prior negative entry expired): fall
    // through to the "database" and remember the negative result.
    metrics.databaseQueries += 1;
    metrics.negativeCacheMisses += 1;
    negativeCache.set(hash, now() + ttlMs);
    return { hash, found: false, source: "database" };
  }

  function getMetrics() {
    const negativeLookups = metrics.negativeCacheHits + metrics.negativeCacheMisses;
    const negativeCacheHitRate =
      negativeLookups === 0 ? 0 : metrics.negativeCacheHits / negativeLookups;
    return { ...metrics, negativeCacheHitRate };
  }

  return { lookup, getMetrics, ttlMs };
}

// Shared instance backing the HTTP mock, mirroring how a real service would
// hold one cache for the process.
const defaultService = createLookupService();

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function handleRequest({ body = {} } = {}, service = defaultService) {
  if (!isPlainObject(body) || typeof body.hash !== "string" || body.hash.trim() === "") {
    return {
      status: 400,
      body: { error: "invalid_request", message: "hash must be a non-empty string" },
    };
  }

  return { status: 200, body: service.lookup(body.hash) };
}

export function handleMetricsRequest(service = defaultService) {
  return { status: 200, body: service.getMetrics() };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/contract-hash/metrics") {
      const { status, body } = handleMetricsRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && req.url === "/contract-hash/lookup") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "invalid_json", message: "Request body must be valid JSON" }),
          );
          return;
        }
        const { status, body: responseBody } = handleRequest({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4285;
  server.listen(port, () => {
    console.log(
      `negative-cache-lookup mock listening on http://localhost:${port}/contract-hash/lookup`,
    );
  });
}
