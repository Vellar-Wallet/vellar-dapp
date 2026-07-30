# Verification Cache Suite

A self-contained route handler simulating a contract verification registry cache lookup.

## Endpoints

### GET /lookup?id=<contractId>

Looks up a contract verification result, caching it after the first lookup and serving subsequent lookups from cache with a hit flag.

**Query Parameters:**
- `id`: Contract identifier

**Response:**
```json
{
  "id": "0x123...",
  "verified": true,
  "sourceCode": "...",
  "cacheHit": false
}
```

On the first lookup, `cacheHit` is `false`. On subsequent lookups for the same id, `cacheHit` is `true`.

### GET /cache-stats

Reports total lookups and total cache hits.

**Response:**
```json
{
  "totalLookups": 10,
  "totalCacheHits": 7,
  "hitRate": 0.7
}
```

## Running the Test

```bash
node test.ts
```

This test demonstrates a first miss, a second hit, and the resulting cache stats.
