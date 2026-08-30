# Mock route: negative caching for contract-hash lookups (Issue #285)

Standalone mock route that simulates a contract-hash lookup service. It adds
negative caching: a "not found" result is remembered for a short TTL so
repeated lookups for a hash that does not exist stop reaching the (simulated)
database.

Positive lookups (a hash that is found) are out of scope for this issue and
always report `source: "database"`.

## Run

```sh
node route.mjs
# negative-cache-lookup mock listening on http://localhost:4285/contract-hash/lookup
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /contract-hash/lookup`

Request:

```json
{ "hash": "wasm_unknown_hash" }
```

Response:

```json
{
  "hash": "wasm_unknown_hash",
  "found": false,
  "source": "cache",
  "cachedUntil": "2026-01-01T00:00:30.000Z"
}
```

`source` is `"database"` the first time a hash is looked up (or after its
negative cache entry expires), and `"cache"` for any repeat lookup of the same
unknown hash within the TTL. `cachedUntil` is only present on cache hits.

### `GET /contract-hash/metrics`

Returns cumulative counters:

```json
{
  "databaseQueries": 4,
  "negativeCacheHits": 2,
  "negativeCacheMisses": 3,
  "negativeCacheHitRate": 0.4
}
```

`negativeCacheHitRate` is `negativeCacheHits / (negativeCacheHits + negativeCacheMisses)`,
i.e. the fraction of lookups for an unknown hash that were served from the
negative cache instead of the database. It is `0` when there have been no
negative lookups yet.

## TTL choice

The negative cache TTL is **30 seconds** (`NEGATIVE_CACHE_TTL_MS` in
[route.mjs](route.mjs)). This balances two costs:

- **Staleness**: if a hash gets registered right after being looked up, it
  should not be reported as missing for long.
- **Load**: a client polling for a not-yet-deployed contract every few
  seconds should not hit the database on every attempt.

30 seconds absorbs several retries within one user-visible interaction (e.g.
waiting for a deploy to finish) while keeping staleness well under a minute.

## Rejected requests

- `hash` missing, empty, or not a string: `400 invalid_request`.

## Notes

- The cache and metrics are created per `createLookupService()` instance so
  tests can run in isolation with an injectable clock (`now`) instead of real
  timers; the HTTP server uses one shared instance for the life of the
  process, as a real service would.
- Nothing is persisted across process restarts; this is a mock of the caching
  behavior, not a real database or cache backend.
