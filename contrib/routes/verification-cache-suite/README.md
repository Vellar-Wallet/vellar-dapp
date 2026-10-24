# Verification Cache Suite

A standalone Node.js HTTP example that simulates a contract verification registry and caches the first result for each ID. It uses only Node built-ins and stores its cache and counters in memory.

Run the test with `node --test server.test.js`. Start the server with `node server.js`; it listens on `127.0.0.1:3002` by default, or on the port in `PORT`.

## Endpoints

### `GET /lookup?id=contract-123`

Returns a sample verification result for the requested ID. The first lookup has `cacheHit: false` and stores the result; later lookups for the same ID return `cacheHit: true`. A missing ID returns `400`.

### `GET /cache-stats`

Returns `totalLookups` (including misses and hits) and `totalCacheHits` for this server instance.
